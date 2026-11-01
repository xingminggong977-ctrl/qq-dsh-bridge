import assert from 'node:assert/strict';
import test from 'node:test';

import { OWNER_QQ, PNG_BASE64, SELF_ID, startHarness, startWithNapCat } from './helpers/harness.js';
import { atSegment, groupMessage, textSegment } from './helpers/ws-stub.js';
import { waitFor } from './helpers/wait.js';
import { ASK_IMAGE_MAX_BYTES, ASK_VOICE_UNHEARD, AskMediaError, createAskInbox } from '../src/ask.js';

const withHarness = async (t) => {
  const harness = await startHarness();
  t.after(async () => {
    await harness.close();
  });
  return harness;
};

/**
 * 扮演 node-plugin：等到任务被排进队列，取走它、标 running、把结果交回 /node/result。
 * 真实 agent 是一整回合的思考，这里只保留协议上真正会被 /node/ask 看见的三步。
 */
async function answerNextTask(harness, { text = '在呢。', ok = true, error = null } = {}) {
  const task = await waitFor(
    async () => {
      const polled = await harness.nodeFetch('/node/poll?wait=0&limit=1');
      return polled.body.tasks?.[0] ?? null;
    },
    { label: 'agent claims the queued task' },
  );
  await harness.nodeFetch('/node/status', { method: 'POST', body: { taskId: task.taskId, state: 'running' } });
  const result = await harness.nodeFetch('/node/result', { method: 'POST', body: { taskId: task.taskId, ok, text, error } });
  return { task, result };
}

const askOnce = (harness, body) => harness.nodeFetch('/node/ask', { method: 'POST', body });

// ---- 单元级用的假件：不启 HTTP、不碰真队列，只看 ask() 交给队列的那一份参数 ----

function fakeBlobs() {
  const saved = [];
  return {
    saved,
    save(buffer, mime) {
      saved.push({ buffer, mime });
      return { blobId: `blob-${saved.length}`, mime, bytes: buffer.byteLength };
    },
  };
}

function fakeInbox({ blobs = null, transcriber = null } = {}) {
  const calls = [];
  const warns = [];
  const queue = {
    insertTask(args) {
      const row = { task_id: `task-${calls.length + 1}`, ...args };
      calls.push(row);
      return row;
    },
  };
  const log = {
    info() {},
    warn(message, detail) {
      warns.push({ message, detail });
    },
    error() {},
  };
  const inbox = createAskInbox({ queue, notifier: { notify() {} }, log, blobs, transcriber });
  return { inbox, calls, warns };
}

/** 起一次 ask()，等任务进队列后替 /node/result 兑现掉——测试不该挂在真超时上。 */
async function askAndSettle(inbox, calls, args) {
  const pending = inbox.ask({ channel: 'wechat', timeoutMs: 60000, ...args });
  await waitFor(() => calls.length === 1, { label: 'ask inserted the task' });
  inbox.settle({ task_id: calls[0].task_id });
  const outcome = await pending;
  assert.equal(outcome.status, 'settled');
  return calls[0];
}

const base64Of = (value) => Buffer.from(value, 'utf8').toString('base64');


test('POST /node/ask returns the agent reply as plain text', async (t) => {
  const harness = await withHarness(t);

  const pending = askOnce(harness, { text: '在吗，用一句话回我', from: 'wechat:wxid_a' });
  const { task } = await answerNextTask(harness, { text: '在的，一直听着呢。' });
  const reply = await pending;

  assert.equal(reply.status, 200);
  assert.equal(reply.body.ok, true);
  assert.equal(reply.body.taskId, task.taskId);
  assert.equal(reply.body.text, '在的，一直听着呢。');
  assert.equal(typeof reply.body.ms, 'number');
});

test('the ask task is queued as ask-origin and reaches the agent without a QQ target', async (t) => {
  const harness = await withHarness(t);

  const pending = askOnce(harness, { text: '今天几号', from: 'wechat:wxid_b', channel: 'wechat' });
  const { task } = await answerNextTask(harness);
  await pending;

  // 上线的那条 Task 自己就写着「别投递」，她那一侧有机会据此收住 QQ 工具。
  assert.equal(task.origin, 'ask');
  assert.equal(task.deliver, false);
  assert.equal('replyTarget' in task, false);
  assert.equal(task.text, '今天几号');

  const row = harness.queue.getRow(task.taskId);
  assert.equal(row.origin, 'ask');
  // 没有 QQ 目标是「万一漏进 dispatch 也发不出去」的第二道保险。
  assert.equal(row.reply_target, 'null');
  // 外部网关不是主人：不能点亮只属于 QQ 主人的语音回复与活跃度。
  assert.equal(row.is_owner, 0);
  assert.equal(row.status, 'done');
});

test('a normal QQ task still carries the untouched protocol fields', async (t) => {
  const { rowToTask } = await import('../src/queue.js');
  const harness = await withHarness(t);
  const row = harness.queue.insertTask({
    kind: 'private',
    groupId: null,
    userId: OWNER_QQ,
    nickname: '主人',
    text: '在吗',
    images: [],
    isOwner: true,
    replyTarget: { kind: 'private', userId: OWNER_QQ },
  });
  const task = rowToTask(row);
  assert.equal('origin' in task, false);
  assert.equal('deliver' in task, false);
});

test('POST /node/ask clamps an over-long timeout to the 120s ceiling', async (t) => {
  const harness = await withHarness(t);

  const pending = askOnce(harness, { text: '你还记得我吗', from: 'api:smoke', timeoutMs: 999999 });
  await answerNextTask(harness);
  const reply = await pending;

  assert.equal(reply.status, 200);
  const enqueued = harness.lines.find((line) => line.includes('ask enqueued'));
  assert.ok(enqueued.includes('"timeoutMs":120000'), enqueued);
});

test('POST /node/ask answers 504 when no result arrives in time', async (t) => {
  const harness = await withHarness(t);

  const reply = await askOnce(harness, { text: '在吗', from: 'wechat:wxid_c', timeoutMs: 60 });

  assert.equal(reply.status, 504);
  assert.equal(reply.body.ok, false);
  assert.equal(reply.body.error, 'timeout');
  assert.match(reply.body.taskId, /^[0-9a-f-]{36}$/);
  assert.equal(harness.app.ask.pendingCount, 0);
});

test('a result that arrives after the timeout is dropped safely', async (t) => {
  const harness = await withHarness(t);

  const reply = await askOnce(harness, { text: '在吗', from: 'wechat:wxid_d', timeoutMs: 60 });
  assert.equal(reply.status, 504);
  const { taskId } = reply.body;

  // 迟到的结果不能炸、不能兑现给下一个人，只能安静地丢掉。
  const late = await harness.nodeFetch('/node/result', {
    method: 'POST',
    body: { taskId, ok: true, text: '我来晚了。' },
  });
  assert.equal(late.status, 200);
  assert.deepEqual(late.body, { ok: true, dropped: true });

  // 这一行仍然要收摊，不能永远停在 delivering 上。
  assert.equal(harness.queue.getRow(taskId).status, 'done');
  assert.equal(harness.app.ask.pendingCount, 0);
  assert.ok(harness.lines.some((line) => line.includes('late ask result dropped')));
});

test('the same taskId is only cashed in once', async (t) => {
  const harness = await withHarness(t);

  const pending = askOnce(harness, { text: '在吗', from: 'wechat:wxid_e' });
  const { task } = await answerNextTask(harness, { text: '第一次。' });
  const first = await pending;
  assert.equal(first.body.text, '第一次。');

  const again = await harness.nodeFetch('/node/result', {
    method: 'POST',
    body: { taskId: task.taskId, ok: true, text: '第二次。' },
  });
  assert.equal(again.status, 200);
  assert.equal(again.body.duplicate, true);
  // 先到的那份才是留下来的，队列不会被后到的覆盖。
  assert.equal(harness.queue.getRow(task.taskId).result_text, '第一次。');
});

test('an agent turn that fails is reported as agent_failed, not as a timeout', async (t) => {
  const harness = await withHarness(t);

  const pending = askOnce(harness, { text: '在吗', from: 'wechat:wxid_f' });
  await answerNextTask(harness, { text: '', ok: false, error: 'model quota exceeded' });
  const reply = await pending;

  assert.equal(reply.status, 502);
  assert.equal(reply.body.ok, false);
  assert.equal(reply.body.error, 'agent_failed');
  assert.equal(reply.body.message, 'model quota exceeded');
});

test('POST /node/ask requires the node token', async (t) => {
  const harness = await withHarness(t);

  const anonymous = await harness.nodeFetch('/node/ask', {
    method: 'POST',
    auth: false,
    body: { text: '在吗', from: 'wechat:x' },
  });
  assert.equal(anonymous.status, 401);
  assert.deepEqual(anonymous.body, { ok: false, error: 'unauthorized' });

  const wrong = await harness.nodeFetch('/node/ask', {
    method: 'POST',
    auth: 'not-the-token',
    body: { text: '在吗', from: 'wechat:x' },
  });
  assert.equal(wrong.status, 401);
  // 认证没过就不能入队，否则谁都能把她叫醒一次。
  assert.equal(harness.queue.queuedCount(), 0);
});

test('POST /node/ask rejects bad arguments before touching the queue', async (t) => {
  const harness = await withHarness(t);
  const cases = [
    [{ from: 'wechat:x' }, 'text is required'],
    [{ text: '   ', from: 'wechat:x' }, 'text must be 1-4000 characters'],
    [{ text: 'x'.repeat(4001), from: 'wechat:x' }, 'text must be 1-4000 characters'],
    [{ text: '在吗' }, 'from is required'],
    [{ text: '在吗', from: 'x'.repeat(65) }, 'from must be 1-64 characters'],
    [{ text: '在吗', from: 'wechat:x', channel: 'qq' }, 'channel must be "wechat" or "api"'],
    [{ text: '在吗', from: 'wechat:x', timeoutMs: 0 }, 'timeoutMs must be a positive number'],
    [{ text: '在吗', from: 'wechat:x', timeoutMs: '60000' }, 'timeoutMs must be a positive number'],
  ];
  for (const [body, message] of cases) {
    const reply = await askOnce(harness, body);
    assert.equal(reply.status, 400, JSON.stringify(body));
    assert.equal(reply.body.ok, false);
    assert.equal(reply.body.error, message);
  }
  assert.equal(harness.queue.queuedCount(), 0);
});

test('only POST is accepted on /node/ask', async (t) => {
  const harness = await withHarness(t);
  const reply = await harness.nodeFetch('/node/ask');
  assert.equal(reply.status, 405);
  assert.equal(reply.headers.get('allow'), 'POST');
});

test('an ask round trip sends nothing to QQ while the QQ path still works', async (t) => {
  const { stub, harness } = await startWithNapCat(t);

  // 1. 借大脑问一句，她答了——但 QQ 上一个字都不该出现。
  const pending = askOnce(harness, { text: '在吗，用一句话回我', from: 'wechat:wxid_g' });
  await answerNextTask(harness, { text: '在呢，你说。' });
  const reply = await pending;
  assert.equal(reply.status, 200);
  assert.equal(stub.sendActions.length, 0);

  // 2. QQ 入站照旧：进队列、被取走、结果发回 QQ。
  stub.inject(
    groupMessage({
      selfId: SELF_ID,
      groupId: '123456',
      userId: OWNER_QQ,
      nickname: '小明',
      segments: [atSegment(SELF_ID), textSegment(' 在吗')],
    }),
  );
  await waitFor(() => harness.queue.queuedCount() === 1, { label: 'qq task queued' });
  const qqTask = (await harness.nodeFetch('/node/poll?wait=0&limit=1')).body.tasks[0];
  assert.equal('origin' in qqTask, false);
  await harness.nodeFetch('/node/status', { method: 'POST', body: { taskId: qqTask.taskId, state: 'running' } });
  await harness.nodeFetch('/node/result', { method: 'POST', body: { taskId: qqTask.taskId, ok: true, text: '在的。' } });

  await waitFor(() => stub.sendActions.length === 1, { label: 'qq reply delivered' });
  const sent = stub.sendActions[0];
  assert.equal(sent.action, 'send_group_msg');
  assert.deepEqual(sent.params.message, [{ type: 'text', data: { text: '在的。' } }]);

  // 3. 两条通路互不沾染：等她的那个等待台早就空了。
  assert.equal(harness.app.ask.pendingCount, 0);
});

test('dispatch refuses an ask row even when it carries a valid QQ target', async (t) => {
  const { stub, harness } = await startWithNapCat(t);

  // 最坏情况：这行既有 origin:'ask'，又带着一个真能发出去的 QQ 目标。
  // http 那条路根本不会把它送到这里，所以这一条是给「万一」留的保险，必须自己拦住。
  const row = harness.queue.insertTask({
    kind: 'private',
    groupId: null,
    userId: OWNER_QQ,
    nickname: '主人',
    text: '借个脑子',
    images: [],
    isOwner: true,
    replyTarget: { kind: 'private', userId: OWNER_QQ },
    origin: 'ask',
  });
  harness.queue.recordResult(row.task_id, { ok: true, text: '这句一个字都不该发到 QQ。', at: Date.now() });

  await harness.dispatch.deliverResult(harness.queue.getRow(row.task_id));

  assert.equal(stub.sendActions.length, 0);
  // 拦住之后这一行也要收摊，不能停在 delivering 上等租约过期。
  assert.equal(harness.queue.getRow(row.task_id).status, 'done');
  assert.ok(harness.lines.some((line) => line.includes('ask task not delivered to qq')));
});

// ---- 图片与语音：微信端递进来的两种非文字素材 ----

test('ask stores inbound images through the blob store and puts them on the task', async () => {
  const blobs = fakeBlobs();
  const { inbox, calls } = fakeInbox({ blobs });
  const bytes = Buffer.from(PNG_BASE64, 'base64');

  const task = await askAndSettle(inbox, calls, {
    text: '这张图里是什么',
    from: 'wechat:wxid_img',
    images: [{ mime: 'image/png', dataBase64: PNG_BASE64 }],
  });

  // 落盘的是解码后的原始字节，不是 base64 字符串。
  assert.deepEqual(blobs.saved[0].buffer, bytes);
  assert.equal(blobs.saved[0].mime, 'image/png');
  // 队列里带的是和 QQ 图片一样的 {blobId, mime, bytes} 凭证。
  assert.deepEqual(task.images, [{ blobId: 'blob-1', mime: 'image/png', bytes: bytes.length }]);
  assert.equal(task.text, '这张图里是什么');
  assert.equal(task.origin, 'ask');
});

test('an image larger than 6 MiB is refused with 413 and never reaches the queue', async () => {
  const { inbox, calls } = fakeInbox({ blobs: fakeBlobs() });
  const huge = Buffer.alloc(ASK_IMAGE_MAX_BYTES + 1, 7).toString('base64');

  await assert.rejects(
    () =>
      inbox.ask({
        text: '看这个',
        from: 'wechat:wxid_big',
        channel: 'wechat',
        timeoutMs: 1000,
        images: [{ mime: 'image/png', dataBase64: huge }],
      }),
    (error) => error instanceof AskMediaError && error.status === 413,
  );
  assert.equal(calls.length, 0);
});

test('voice notes are transcribed and prepended as [语音] lines, the text kept last', async () => {
  const heard = ['今天天气不错', '出去走走吧'];
  let seen = 0;
  const transcriber = {
    enabled: true,
    async transcribe() {
      return heard[seen++];
    },
  };
  const { inbox, calls } = fakeInbox({ transcriber });

  const task = await askAndSettle(inbox, calls, {
    text: '带我去散步',
    from: 'wechat:wxid_voice',
    audios: [
      { mime: 'audio/mpeg', dataBase64: base64Of('first-clip') },
      { mime: 'audio/silk', dataBase64: base64Of('second-clip') },
    ],
  });

  // 两条按顺序逐条转写，都排在原文前面：她先读到他嘴里说的话。
  assert.equal(task.text, `[语音] ${heard[0]}\n[语音] ${heard[1]}\n带我去散步`);
  assert.equal(task.images.length, 0);
  assert.equal(seen, 2);
});

test('a transcription failure degrades to a placeholder instead of failing the ask', async () => {
  const transcriber = {
    enabled: true,
    async transcribe() {
      throw new Error('asr http 401');
    },
  };
  const { inbox, calls, warns } = fakeInbox({ transcriber });

  const task = await askAndSettle(inbox, calls, {
    text: '听听这个',
    from: 'wechat:wxid_voice',
    audios: [{ mime: 'audio/mpeg', dataBase64: base64Of('boom') }],
  });

  // 请求照旧入队：听不懂一条语音不该等于丢一条消息。
  assert.equal(task.text, `${ASK_VOICE_UNHEARD}\n听听这个`);
  const warn = warns.find((line) => line.message === 'ask voice transcription failed');
  assert.ok(warn, JSON.stringify(warns));
  assert.equal(warn.detail.reason, 'asr http 401');
});

test('with no transcriber the voice line still degrades and the ask goes through', async () => {
  const { inbox, calls, warns } = fakeInbox();

  const task = await askAndSettle(inbox, calls, {
    text: '在吗',
    from: 'wechat:wxid_voice',
    audios: [{ mime: 'audio/silk', dataBase64: base64Of('silk-bytes') }],
  });

  assert.equal(task.text, `${ASK_VOICE_UNHEARD}\n在吗`);
  assert.ok(warns.some((line) => line.message === 'ask voice not transcribed'));
});

test('POST /node/ask stores an image blob the agent can hand back to nobody but itself', async (t) => {
  const harness = await withHarness(t);
  // 1.5 MB 解码后：老的 1 MiB 请求体上限装不下，这条同时证明 ask 那条路由放宽了。
  const bytes = Buffer.alloc(1536 * 1024, 9);
  const dataBase64 = bytes.toString('base64');

  const pending = askOnce(harness, {
    text: '这张图里是什么',
    from: 'wechat:wxid_img',
    images: [{ mime: 'image/png', dataBase64 }],
  });
  const { task } = await answerNextTask(harness, { text: '一片纯色。' });
  const reply = await pending;

  assert.equal(reply.status, 200);
  assert.equal(task.images.length, 1);
  const [image] = task.images;
  assert.match(image.blobId, /^[0-9a-f-]{36}$/);
  assert.equal(image.mime, 'image/png');
  assert.equal(image.bytes, bytes.length);

  // 入队那一刻真落盘了：/node/blob/:id 能把同一份字节取回来。
  const fetched = await fetch(`${harness.base}/blob/${image.blobId}`, {
    headers: { authorization: `Bearer ${harness.config.nodeToken}` },
  });
  assert.equal(fetched.status, 200);
  assert.equal(fetched.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await fetched.arrayBuffer()), bytes);
  assert.equal(harness.blobs.find(image.blobId).bytes, bytes.length);
});

test('POST /node/ask rejects malformed or oversize media with 400/413', async (t) => {
  const harness = await withHarness(t);
  const okImage = { mime: 'image/png', dataBase64: PNG_BASE64 };
  const okAudio = { mime: 'audio/mpeg', dataBase64: base64Of('clip') };
  const cases = [
    [{ text: '在吗', from: 'wechat:x', images: 'nope' }, 400, 'images must be an array'],
    [
      { text: '在吗', from: 'wechat:x', images: Array.from({ length: 5 }, () => okImage) },
      413,
      'images must be at most 4 items',
    ],
    [
      { text: '在吗', from: 'wechat:x', audios: [okAudio, okAudio, okAudio] },
      413,
      'audios must be at most 2 items',
    ],
    [
      { text: '在吗', from: 'wechat:x', images: [{ mime: 'image/tiff', dataBase64: PNG_BASE64 }] },
      400,
      'images[0].mime must be one of image/jpeg, image/png, image/webp, image/gif',
    ],
    [
      { text: '在吗', from: 'wechat:x', images: [{ mime: 'image/png', dataBase64: 'not base64 !!!' }] },
      400,
      'images[0].dataBase64 is not valid base64',
    ],
    [{ text: '在吗', from: 'wechat:x', audios: [{ mime: 'audio/mpeg' }] }, 400, 'audios[0].dataBase64 is required'],
  ];
  for (const [body, status, message] of cases) {
    const reply = await askOnce(harness, body);
    assert.equal(reply.status, status, JSON.stringify(body));
    assert.deepEqual(reply.body, { ok: false, error: message });
  }
  // 一条都没进队列：校验不过的请求不该把她叫醒。
  assert.equal(harness.queue.queuedCount(), 0);
});

test('POST /node/ask accepts a picture with no text and labels it', async (t) => {
  const harness = await withHarness(t);
  const pending = askOnce(harness, {
    text: '',
    from: 'wechat:x',
    images: [{ mime: 'image/png', dataBase64: PNG_BASE64 }],
  });
  const { task } = await answerNextTask(harness, { text: '一只猫。' });
  const reply = await pending;

  assert.equal(reply.status, 200);
  assert.equal(task.text, '[图片]');
  assert.equal(task.images.length, 1);
});

test('POST /node/ask still rejects an empty text with no media', async (t) => {
  const harness = await withHarness(t);
  const reply = await askOnce(harness, { text: '   ', from: 'wechat:x' });
  assert.equal(reply.status, 400);
  assert.deepEqual(reply.body, { ok: false, error: 'text must be 1-4000 characters' });
});

test('POST /node/ask degrades a voice note it cannot transcribe instead of failing', async (t) => {
  // 测试环境没配任何 ASR：注入给 ask 的是 null，走「没听清」的占位行。
  const harness = await withHarness(t);

  const pending = askOnce(harness, {
    text: '听我说一句',
    from: 'wechat:wxid_voice',
    audios: [{ mime: 'audio/mpeg', dataBase64: base64Of('fake-mp3-bytes') }],
  });
  const { task } = await answerNextTask(harness);
  const reply = await pending;

  assert.equal(reply.status, 200);
  assert.equal(reply.body.ok, true);
  assert.equal(task.text, `${ASK_VOICE_UNHEARD}\n听我说一句`);
  assert.equal(task.images.length, 0);
  assert.ok(harness.lines.some((line) => line.includes('ask voice not transcribed')));
});
