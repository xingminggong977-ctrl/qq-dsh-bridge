import assert from 'node:assert/strict';
import test from 'node:test';

import { startHarness } from './helpers/harness.js';

const TASK = (overrides = {}) => ({
  kind: 'group',
  groupId: '123456',
  userId: '10001',
  nickname: '小明',
  text: '你好',
  images: [],
  isOwner: true,
  replyTarget: { kind: 'group', groupId: '123456' },
  ...overrides,
});

async function withHarness(t) {
  const harness = await startHarness();
  t.after(() => harness.close());
  return harness;
}

test('GET /health is public and reports queue depth', async (t) => {
  const harness = await withHarness(t);
  const first = await harness.nodeFetch('/health', { auth: false });
  assert.equal(first.status, 200);
  assert.deepEqual(Object.keys(first.body).sort(), ['napcat', 'ok', 'queued', 'uptimeMs']);
  assert.equal(first.body.ok, true);
  // 这个用例只起 HTTP 服务，没有真的 NapCat 连接，所以是 down；e2e 里才应该是 up。
  assert.match(first.body.napcat, /^(up|down)$/, 'the health payload must say whether the QQ link itself is alive');
  assert.equal(first.body.queued, 0);
  assert.equal(typeof first.body.uptimeMs, 'number');
  assert.match(first.headers.get('content-type'), /application\/json/);

  harness.queue.insertTask(TASK());
  const second = await harness.nodeFetch('/health', { auth: false });
  assert.equal(second.body.queued, 1);

  const wrongMethod = await harness.nodeFetch('/health', { auth: false, method: 'POST' });
  assert.equal(wrongMethod.status, 405);
});

test('/node/* and /blob/* demand the bearer token', async (t) => {
  const harness = await withHarness(t);
  const endpoints = [
    { pathname: '/node/poll?wait=0', method: 'GET' },
    { pathname: '/node/status', method: 'POST', body: {} },
    { pathname: '/node/result', method: 'POST', body: {} },
    { pathname: '/blob/anything', method: 'GET' },
  ];
  for (const { pathname, method, body } of endpoints) {
    const missing = await harness.nodeFetch(pathname, { auth: false, method, body });
    assert.equal(missing.status, 401, `${pathname} without a token`);
    assert.deepEqual(missing.body, { ok: false, error: 'unauthorized' });

    const wrong = await harness.nodeFetch(pathname, { auth: 'not-the-token', method, body });
    assert.equal(wrong.status, 401, `${pathname} with a wrong token`);
  }
});

test('unknown routes are 404, even with a valid token', async (t) => {
  const harness = await withHarness(t);
  for (const pathname of ['/', '/nope', '/node/unknown', '/nodexpoll']) {
    const response = await harness.nodeFetch(pathname);
    assert.equal(response.status, 404, pathname);
    assert.equal(response.body.ok, false);
  }
});

test('poll hands out protocol-shaped tasks and leases them', async (t) => {
  const harness = await withHarness(t);
  const row = harness.queue.insertTask(TASK({ images: [{ blobId: 'blob-1', mime: 'image/png', bytes: 70 }] }));

  const response = await harness.nodeFetch('/node/poll?wait=0&limit=2');
  assert.equal(response.status, 200);
  assert.equal(response.body.tasks.length, 1);
  const task = response.body.tasks[0];
  assert.deepEqual(Object.keys(task).sort(), [
    'deadlineAt',
    'groupId',
    'images',
    'isOwner',
    'kind',
    'mentioned',
    'needsReply',
    'nickname',
    'receivedAt',
    'taskId',
    'text',
    'userId',
  ]);
  assert.equal(task.taskId, row.task_id);
  assert.equal(task.mentioned, true);
  assert.equal(task.needsReply, true);
  assert.deepEqual(task.images, [{ blobId: 'blob-1', mime: 'image/png', bytes: 70 }]);
  assert.equal(harness.queue.getRow(row.task_id).status, 'delivering');

  const again = await harness.nodeFetch('/node/poll?wait=0&limit=2');
  assert.deepEqual(again.body.tasks, []);
});

test('poll clamps limit to 5 and rejects non-numeric parameters', async (t) => {
  const harness = await withHarness(t);
  for (let index = 0; index < 6; index += 1) harness.queue.insertTask(TASK({ text: `消息 ${index}` }));

  const clamped = await harness.nodeFetch('/node/poll?wait=0&limit=99');
  assert.equal(clamped.body.tasks.length, 5);

  const badWait = await harness.nodeFetch('/node/poll?wait=abc');
  assert.equal(badWait.status, 400);
  assert.equal(badWait.body.ok, false);

  const badLimit = await harness.nodeFetch('/node/poll?limit=1.5');
  assert.equal(badLimit.status, 400);
});

test('a parked poll wakes up when a task arrives', async (t) => {
  const harness = await withHarness(t);
  const parked = harness.nodeFetch('/node/poll?wait=5&limit=1');
  await new Promise((resolve) => setTimeout(resolve, 30));
  harness.queue.insertTask(TASK({ text: '醒醒' }));
  harness.notifier.notify();
  const response = await parked;
  assert.equal(response.body.tasks.length, 1);
  assert.equal(response.body.tasks[0].text, '醒醒');
});

test('POST /node/status validates input and marks the task running', async (t) => {
  const harness = await withHarness(t);
  const row = harness.queue.insertTask(TASK());

  assert.equal((await harness.nodeFetch('/node/status', { method: 'POST', body: {} })).status, 400);
  assert.equal(
    (await harness.nodeFetch('/node/status', { method: 'POST', body: { taskId: row.task_id, state: 'nope' } })).status,
    400,
  );
  assert.equal(
    (await harness.nodeFetch('/node/status', { method: 'POST', body: { taskId: row.task_id, state: 1 } })).status,
    400,
  );
  const unknown = await harness.nodeFetch('/node/status', { method: 'POST', body: { taskId: 'nope', state: 'running' } });
  assert.equal(unknown.status, 404);

  const accepted = await harness.nodeFetch('/node/status', {
    method: 'POST',
    body: { taskId: row.task_id, state: 'accepted', ignoredField: true },
  });
  assert.equal(accepted.status, 200);
  assert.deepEqual(accepted.body, { ok: true });
  assert.equal(harness.queue.getRow(row.task_id).status, 'running');

  const running = await harness.nodeFetch('/node/status', {
    method: 'POST',
    body: { taskId: row.task_id, state: 'running' },
  });
  assert.equal(running.status, 200);
});

test('POST /node/result validates input, is idempotent and answers duplicates', async (t) => {
  const harness = await withHarness(t);
  const row = harness.queue.insertTask(TASK({ kind: 'private', groupId: null, replyTarget: { kind: 'private', userId: '10001' } }));

  assert.equal((await harness.nodeFetch('/node/result', { method: 'POST', body: {} })).status, 400);
  assert.equal(
    (await harness.nodeFetch('/node/result', { method: 'POST', body: { taskId: row.task_id, ok: 'yes', text: 'x' } })).status,
    400,
  );
  assert.equal(
    (await harness.nodeFetch('/node/result', { method: 'POST', body: { taskId: row.task_id, ok: true } })).status,
    400,
  );
  assert.equal(
    (await harness.nodeFetch('/node/result', { method: 'POST', body: { taskId: row.task_id, ok: true, text: 'x', error: 5 } }))
      .status,
    400,
  );
  assert.equal(
    (await harness.nodeFetch('/node/result', { method: 'POST', body: { taskId: 'nope', ok: true, text: 'x' } })).status,
    404,
  );

  const first = await harness.nodeFetch('/node/result', { method: 'POST', body: { taskId: row.task_id, ok: true, text: '好的' } });
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, { ok: true });

  const duplicate = await harness.nodeFetch('/node/result', {
    method: 'POST',
    body: { taskId: row.task_id, ok: true, text: '重复' },
  });
  assert.equal(duplicate.status, 200);
  assert.deepEqual(duplicate.body, { ok: true, duplicate: true });
  assert.equal(harness.queue.getRow(row.task_id).result_text, '好的');
});

test('GET /blob/<id> serves the stored bytes with the stored mime', async (t) => {
  const harness = await withHarness(t);
  const bytes = Buffer.from('89504e470d0a1a0a', 'hex');
  const stored = harness.blobs.save(bytes, 'image/png');

  const response = await fetch(`${harness.base}/blob/${stored.blobId}`, {
    headers: { authorization: `Bearer ${harness.config.nodeToken}` },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(Buffer.from(await response.arrayBuffer()).toString('hex'), bytes.toString('hex'));

  const missing = await harness.nodeFetch('/blob/does-not-exist');
  assert.equal(missing.status, 404);
  const unauth = await fetch(`${harness.base}/blob/${stored.blobId}`);
  assert.equal(unauth.status, 401);
});

test('malformed JSON bodies are rejected with 400, wrong methods with 405', async (t) => {
  const harness = await withHarness(t);
  const broken = await harness.nodeFetch('/node/result', { method: 'POST', raw: '{"taskId":' });
  assert.equal(broken.status, 400);
  assert.equal(broken.body.ok, false);

  const list = await harness.nodeFetch('/node/result', { method: 'POST', raw: '[1,2]' });
  assert.equal(list.status, 400);

  const wrongMethod = await harness.nodeFetch('/node/poll?wait=0', { method: 'POST' });
  assert.equal(wrongMethod.status, 405);
});

test('the response never leaks tokens or internals', async (t) => {
  const harness = await withHarness(t);
  const body = await harness.nodeFetch('/node/poll?wait=0', { auth: false });
  assert.ok(!body.text.includes(harness.config.nodeToken));
  const bad = await harness.nodeFetch('/node/status', { method: 'POST', raw: 'nope' });
  assert.equal(bad.body.error, 'request body is not valid JSON');
  assert.ok(!bad.text.includes('\n    at '));
});
