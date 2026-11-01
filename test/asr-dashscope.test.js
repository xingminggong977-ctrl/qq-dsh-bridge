import test from 'node:test';
import assert from 'node:assert/strict';

import { createDashscopeTranscriber } from '../src/asr-dashscope.js';

const MP3 = Buffer.from('49443304000000000000-真mp3不会长这样', 'utf8');
const BEIJING = 'https://dashscope.aliyuncs.com';
const POLICY = {
  upload_host: 'https://dashscope-file-mgr.oss-cn-beijing.aliyuncs.com',
  upload_dir: 'dashscope-instant/abc123/2025-11-01/deadbeef',
  policy: 'cG9saWN5',
  signature: 'U0lHTg==',
  oss_access_key_id: 'LTESTAK',
  x_oss_object_acl: 'private',
  x_oss_forbid_overwrite: true,
};

/** 把响应写成 JSON。 */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** 按顺序吐出预置响应的假 fetch，同时把每个请求记下来供断言。 */
function scripted(steps) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const index = calls.length;
    calls.push({ url: String(url), init });
    if (index >= steps.length) throw new Error(`unexpected fetch #${index + 1} ${url}`);
    const step = steps[index];
    if (typeof step === 'function') return step(String(url), init);
    return step;
  };
  return { fetchImpl, calls };
}

/** 成功链路的前四步（凭证 / 上传 / 提交 / 轮询成功）。 */
function happySteps(text = '  你好，我是小七。 ') {
  return [
    json({ request_id: 'r0', data: POLICY }),
    new Response('', { status: 200 }),
    json({ request_id: 'r1', output: { task_id: 'task-1', task_status: 'PENDING' } }),
    json({
      request_id: 'r2',
      output: {
        task_id: 'task-1',
        task_status: 'SUCCEEDED',
        results: [{ file_url: 'oss://x', subtask_status: 'SUCCEEDED', transcription_url: 'https://result.oss.example/t.json?sig=1' }],
        task_metrics: { TOTAL: 1, SUCCEEDED: 1, FAILED: 0 },
      },
      usage: { duration: 3 },
    }),
    json({ transcripts: [{ channel_id: 0, text }] }),
  ];
}

test('成功路径：四个请求的 URL / method / header / body 都对，返回去掉首尾空白的文本', async () => {
  const { fetchImpl, calls } = scripted(happySteps());
  const transcriber = createDashscopeTranscriber({ apiKey: 'sk-test', fetchImpl });

  assert.equal(transcriber.enabled, true);
  assert.equal(transcriber.model, 'paraformer-v2');
  assert.equal(await transcriber.transcribe(MP3), '你好，我是小七。');
  assert.equal(calls.length, 5);

  // 1. 取上传凭证
  assert.equal(calls[0].url, `${BEIJING}/api/v1/uploads?action=getPolicy&model=paraformer-v2`);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers.authorization, 'Bearer sk-test');

  // 2. 传 OSS：multipart 表单字段齐全，文件名唯一且与提交的 oss:// 一致
  assert.equal(calls[1].url, POLICY.upload_host);
  assert.equal(calls[1].init.method, 'POST');
  const form = calls[1].init.body;
  assert.ok(form instanceof FormData);
  assert.equal(form.get('OSSAccessKeyId'), 'LTESTAK');
  assert.equal(form.get('Signature'), 'U0lHTg==');
  assert.equal(form.get('policy'), 'cG9saWN5');
  assert.equal(form.get('x-oss-object-acl'), 'private');
  assert.equal(form.get('x-oss-forbid-overwrite'), 'true');
  assert.equal(form.get('success_action_status'), '200');
  const objectKey = form.get('key');
  assert.match(objectKey, /^dashscope-instant\/abc123\/2025-11-01\/deadbeef\/qq-voice-[0-9a-f-]+\.mp3$/);
  const file = form.get('file');
  assert.equal(file.name, objectKey.split('/').pop());
  assert.equal(file.size, MP3.length);

  // 3. 提交任务
  assert.equal(calls[2].url, `${BEIJING}/api/v1/services/audio/asr/transcription`);
  assert.equal(calls[2].init.method, 'POST');
  assert.equal(calls[2].init.headers.authorization, 'Bearer sk-test');
  assert.equal(calls[2].init.headers['content-type'], 'application/json');
  assert.equal(calls[2].init.headers['x-dashscope-async'], 'enable');
  assert.equal(calls[2].init.headers['x-dashscope-ossresourceresolve'], 'enable');
  const submit = JSON.parse(calls[2].init.body);
  assert.equal(submit.model, 'paraformer-v2');
  assert.deepEqual(submit.input.file_urls, [`oss://${objectKey}`]);
  assert.deepEqual(submit.parameters.channel_id, [0]);
  assert.deepEqual(submit.parameters.language_hints, ['zh']);

  // 4. 轮询
  assert.equal(calls[3].url, `${BEIJING}/api/v1/tasks/task-1`);
  assert.equal(calls[3].init.method, 'GET');
  assert.equal(calls[3].init.headers.authorization, 'Bearer sk-test');

  // 5. 下载结果：预签名直链，绝不带 API Key
  assert.equal(calls[4].url, 'https://result.oss.example/t.json?sig=1');
  assert.equal(calls[4].init.headers?.authorization, undefined);
});

test('401：key 错，message 里能看出是 401 而不是别的', async () => {
  const { fetchImpl } = scripted([json({ code: 'InvalidApiKey', message: 'Invalid API-key provided.' }, 401)]);
  const transcriber = createDashscopeTranscriber({ apiKey: 'sk-bad', fetchImpl });
  await assert.rejects(
    () => transcriber.transcribe(MP3),
    (error) => {
      assert.match(error.message, /401/);
      assert.match(error.message, /key rejected/);
      assert.match(error.message, /InvalidApiKey/);
      return true;
    },
  );
});

test('402：欠费，和 401 的文案不撞', async () => {
  const { fetchImpl } = scripted([json({ code: 'Arrearage', message: 'Access denied, please make sure your account is in good standing.' }, 402)]);
  const transcriber = createDashscopeTranscriber({ apiKey: 'sk-poor', fetchImpl });
  await assert.rejects(
    () => transcriber.transcribe(MP3),
    (error) => {
      assert.match(error.message, /402/);
      assert.match(error.message, /payment required/);
      assert.match(error.message, /Arrearage/);
      return true;
    },
  );
});

test('429：限流后重试，第二次成功；默认首次间隔约 500ms', async () => {
  const { fetchImpl, calls } = scripted([json({ code: 'Throttling' }, 429), ...happySteps('好的')]);
  const transcriber = createDashscopeTranscriber({ apiKey: 'sk-test', fetchImpl });
  const startedAt = Date.now();
  assert.equal(await transcriber.transcribe(MP3), '好的');
  const elapsed = Date.now() - startedAt;
  assert.equal(calls.length, 6);
  assert.ok(elapsed >= 450, `默认重试间隔应约 500ms，实测 ${elapsed}ms`);
});

test('5xx：重试两次后仍失败 → 错误带状态码与尝试次数', async () => {
  const { fetchImpl, calls } = scripted([
    new Response('upstream boom', { status: 503 }),
    new Response('upstream boom', { status: 503 }),
    new Response('upstream boom', { status: 503 }),
  ]);
  const transcriber = createDashscopeTranscriber({ apiKey: 'sk-test', fetchImpl, retryDelayMs: 1 });
  await assert.rejects(
    () => transcriber.transcribe(MP3),
    (error) => {
      assert.match(error.message, /http 503/);
      assert.match(error.message, /after 3 attempts/);
      assert.match(error.message, /upstream boom/);
      return true;
    },
  );
  // 最多 2 次重试 = 共 3 次请求，不会有第 4 次
  assert.equal(calls.length, 3);
});

test('任务 FAILED：错误里带 code 与 message', async () => {
  const { fetchImpl } = scripted([
    json({ data: POLICY }),
    new Response('', { status: 200 }),
    json({ output: { task_id: 'task-2', task_status: 'PENDING' } }),
    json({
      output: {
        task_id: 'task-2',
        task_status: 'FAILED',
        code: 'InvalidFile.DownloadFailed',
        message: 'The audio file cannot be downloaded.',
      },
    }),
  ]);
  const transcriber = createDashscopeTranscriber({ apiKey: 'sk-test', fetchImpl });
  await assert.rejects(
    () => transcriber.transcribe(MP3),
    (error) => {
      assert.match(error.message, /task failed InvalidFile\.DownloadFailed/);
      assert.match(error.message, /cannot be downloaded/);
      return true;
    },
  );
});

test('任务 SUCCEEDED 但子任务 FAILED：按 subtask_status 判失败（文档的坑）', async () => {
  const { fetchImpl } = scripted([
    json({ data: POLICY }),
    new Response('', { status: 200 }),
    json({ output: { task_id: 'task-3', task_status: 'PENDING' } }),
    json({
      output: {
        task_id: 'task-3',
        task_status: 'SUCCEEDED',
        results: [{ subtask_status: 'FAILED', code: 'InvalidFile.Format', message: 'Unsupported audio format.' }],
        task_metrics: { TOTAL: 1, SUCCEEDED: 0, FAILED: 1 },
      },
    }),
  ]);
  const transcriber = createDashscopeTranscriber({ apiKey: 'sk-test', fetchImpl });
  await assert.rejects(
    () => transcriber.transcribe(MP3),
    (error) => {
      assert.match(error.message, /task failed InvalidFile\.Format/);
      assert.match(error.message, /Unsupported audio format/);
      return true;
    },
  );
});

test('轮询超时：一直 RUNNING 就到点报错，并带上最后状态', async () => {
  const running = () => json({ output: { task_id: 'task-4', task_status: 'RUNNING' } });
  const { fetchImpl, calls } = scripted([json({ data: POLICY }), new Response('', { status: 200 }), json({ output: { task_id: 'task-4', task_status: 'PENDING' } }), ...Array.from({ length: 50 }, running)]);
  const transcriber = createDashscopeTranscriber({ apiKey: 'sk-test', fetchImpl, timeoutMs: 150, pollIntervalMs: 10 });
  await assert.rejects(
    () => transcriber.transcribe(MP3),
    (error) => {
      assert.match(error.message, /poll timeout after 150ms/);
      assert.match(error.message, /last status RUNNING/);
      return true;
    },
  );
  assert.ok(calls.length >= 4);
});

test('网络异常：fetch 抛错 → 分类成 network，不吞原文', async () => {
  const { fetchImpl } = scripted([
    () => {
      throw new TypeError('fetch failed: getaddrinfo ENOTFOUND dashscope.aliyuncs.com');
    },
  ]);
  const transcriber = createDashscopeTranscriber({ apiKey: 'sk-test', fetchImpl });
  await assert.rejects(
    () => transcriber.transcribe(MP3),
    (error) => {
      assert.match(error.message, /network/);
      assert.match(error.message, /ENOTFOUND/);
      return true;
    },
  );
});

test('返回非 JSON：网关错误页也能分类', async () => {
  const { fetchImpl } = scripted([new Response('<html><body>502 Bad Gateway</body></html>', { status: 200 })]);
  const transcriber = createDashscopeTranscriber({ apiKey: 'sk-test', fetchImpl });
  await assert.rejects(
    () => transcriber.transcribe(MP3),
    (error) => {
      assert.match(error.message, /reply not json/);
      assert.match(error.message, /502 Bad Gateway/);
      return true;
    },
  );
});

test('空文本：转录内容全空白时返回空串而不是抛错', async () => {
  const { fetchImpl } = scripted(happySteps('   \n\t '));
  const transcriber = createDashscopeTranscriber({ apiKey: 'sk-test', fetchImpl });
  assert.equal(await transcriber.transcribe(MP3), '');
});

test('没有 transcripts 字段也当空文本', async () => {
  const { fetchImpl } = scripted([...happySteps().slice(0, 4), json({ file_url: 'oss://x', properties: {} })]);
  const transcriber = createDashscopeTranscriber({ apiKey: 'sk-test', fetchImpl });
  assert.equal(await transcriber.transcribe(MP3), '');
});

test('只给 apiKey：model 默认 paraformer-v2，请求体里也是它', async () => {
  const { fetchImpl, calls } = scripted(happySteps('默认模型'));
  const transcriber = createDashscopeTranscriber({ apiKey: 'sk-test', fetchImpl });
  assert.equal(transcriber.model, 'paraformer-v2');
  assert.equal(await transcriber.transcribe(MP3), '默认模型');
  assert.equal(JSON.parse(calls[2].init.body).model, 'paraformer-v2');
  assert.equal(calls[0].url.endsWith('model=paraformer-v2'), true);
});

test('自定义 model：凭证与提交两处都跟着变（文件与模型绑定）', async () => {
  const { fetchImpl, calls } = scripted(happySteps('8k'));
  const transcriber = createDashscopeTranscriber({ apiKey: 'sk-test', model: 'paraformer-8k-v2', fetchImpl });
  assert.equal(await transcriber.transcribe(MP3), '8k');
  assert.equal(calls[0].url.endsWith('model=paraformer-8k-v2'), true);
  assert.equal(JSON.parse(calls[2].init.body).model, 'paraformer-8k-v2');
});

test('没给 apiKey 返回 null；空音频直接返回空串且不发请求', async () => {
  assert.equal(createDashscopeTranscriber({}), null);
  assert.equal(createDashscopeTranscriber({ apiKey: '' }), null);

  const { fetchImpl, calls } = scripted([]);
  const transcriber = createDashscopeTranscriber({ apiKey: 'sk-test', fetchImpl });
  assert.equal(await transcriber.transcribe(Buffer.alloc(0)), '');
  assert.equal(calls.length, 0);
});

test('region=singapore 走 dashscope-intl 域名', async () => {
  const { fetchImpl, calls } = scripted(happySteps('hi'));
  const transcriber = createDashscopeTranscriber({ apiKey: 'sk-test', region: 'singapore', fetchImpl });
  assert.equal(await transcriber.transcribe(MP3), 'hi');
  assert.equal(calls[0].url, 'https://dashscope-intl.aliyuncs.com/api/v1/uploads?action=getPolicy&model=paraformer-v2');
  assert.equal(calls[3].url, 'https://dashscope-intl.aliyuncs.com/api/v1/tasks/task-1');
});

test('region 写错直接抛，不要静默用错地域（两地 API Key 不通用）', () => {
  assert.throws(() => createDashscopeTranscriber({ apiKey: 'sk-test', region: 'cn-beijing' }), /unknown region: cn-beijing/);
});

test('提交任务返回里没有 task_id 也要报出来，而不是拿 undefined 去轮询', async () => {
  const { fetchImpl } = scripted([json({ data: POLICY }), new Response('', { status: 200 }), json({ output: { task_status: 'PENDING' } })]);
  const transcriber = createDashscopeTranscriber({ apiKey: 'sk-test', fetchImpl });
  await assert.rejects(() => transcriber.transcribe(MP3), /submit reply unexpected/);
});
