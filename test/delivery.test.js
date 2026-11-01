import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_TIMING } from '../src/app.js';
import { RATE_LIMIT_NOTICE, chunkText } from '../src/dispatch.js';
import { groupTask, startWithNapCat } from './helpers/harness.js';
import { privateMessage, textSegment } from './helpers/ws-stub.js';
import { sleep, waitFor } from './helpers/wait.js';

const FAST = { sendBackoffMs: [1, 1, 1], segmentDelayMs: 0, pollSliceMs: 25 };

test('timing defaults follow the protocol contract', () => {
  assert.equal(DEFAULT_TIMING.segmentChars, 1800);
  assert.equal(DEFAULT_TIMING.segmentDelayMs, 300);
  assert.deepEqual(DEFAULT_TIMING.sendBackoffMs, [1000, 2000, 4000]);
});

test('chunkText splits on code points, never on surrogate pairs', () => {
  assert.deepEqual(
    chunkText('a'.repeat(3700), 1800).map((chunk) => chunk.length),
    [1800, 1800, 100],
  );
  assert.deepEqual(chunkText('', 1800), []);
  const emoji = '😀'.repeat(2000);
  const chunks = chunkText(emoji, 1800);
  assert.equal(chunks.join(''), emoji);
  assert.ok(chunks.every((chunk) => !/[\uD800-\uDBFF]$/.test(chunk) && !/^[\uDC00-\uDFFF]/.test(chunk)));
});

test('a long answer is split into 1800 character chunks with the protocol delay', async (t) => {
  const { stub, harness } = await startWithNapCat(t, {
    timing: { sendBackoffMs: [1, 1, 1], segmentDelayMs: 300, pollSliceMs: 25 },
  });
  const row = harness.queue.insertTask(groupTask());
  const text = '字'.repeat(4000);
  const startedAt = Date.now();

  await harness.nodeFetch('/node/result', { method: 'POST', body: { taskId: row.task_id, ok: true, text } });
  await waitFor(() => stub.sendActions.length === 3, { label: 'three chunks' });

  assert.deepEqual(
    stub.sentTexts.map((chunk) => chunk.length),
    [1800, 1800, 400],
  );
  assert.equal(stub.sentTexts.join(''), text);
  assert.ok(Date.now() - startedAt >= 550, 'two 300ms gaps between three chunks');
  await waitFor(() => harness.queue.getRow(row.task_id).status === 'done', { label: 'task done' });
});

test('failed sends are retried with the backoff ladder', async (t) => {
  const { stub, harness } = await startWithNapCat(t, { timing: FAST });
  const row = harness.queue.insertTask(groupTask({ text: '在吗' }));

  let failures = 0;
  stub.actionHandler = (record) => {
    if (!record.action.startsWith('send_')) return null;
    if (failures < 2) {
      failures += 1;
      return { status: 'failed', retcode: 100 };
    }
    return null;
  };

  await harness.nodeFetch('/node/result', {
    method: 'POST',
    body: { taskId: row.task_id, ok: true, text: '重试之后成功' },
  });

  await waitFor(() => stub.sendActions.length === 3, { label: 'three attempts' });
  await waitFor(() => harness.queue.getRow(row.task_id).status === 'done', { label: 'delivered' });
  assert.equal(failures, 2);
  assert.deepEqual(stub.sentTexts, ['重试之后成功', '重试之后成功', '重试之后成功']);
});

test('a reply that never gets through ends up failed, not done', async (t) => {
  const { stub, harness } = await startWithNapCat(t, { timing: FAST });
  const row = harness.queue.insertTask(groupTask());
  stub.actionHandler = (record) => (record.action.startsWith('send_') ? { status: 'failed', retcode: 100 } : null);

  const response = await harness.nodeFetch('/node/result', {
    method: 'POST',
    body: { taskId: row.task_id, ok: true, text: '发不出去' },
  });
  assert.equal(response.status, 200);

  await waitFor(() => stub.sendActions.length === 4, { label: 'first try plus three retries' });
  await waitFor(() => harness.queue.getRow(row.task_id).status === 'failed', { label: 'failed task' });
  assert.equal(harness.queue.getRow(row.task_id).result_ok, 1);
});

test('more than six messages a minute are dropped with a single hint', async (t) => {
  const { stub, harness } = await startWithNapCat(t, { timing: FAST });
  for (let index = 0; index < 8; index += 1) {
    stub.inject(privateMessage({ userId: '20002', segments: [textSegment(`第 ${index} 条`)] }));
  }

  await waitFor(() => harness.queue.queuedCount() === 6, { label: 'six queued tasks' });
  await waitFor(() => stub.sentTexts.length === 1, { label: 'rate limit hint' });
  await sleep(120);
  assert.deepEqual(stub.sentTexts, [RATE_LIMIT_NOTICE]);
  assert.equal(harness.queue.db.prepare('SELECT COUNT(*) AS c FROM tasks').get().c, 6);
});

test('a failing turn with an empty answer is finished without touching QQ', async (t) => {
  const { stub, harness } = await startWithNapCat(t, { timing: FAST });
  const row = harness.queue.insertTask(groupTask({ text: '会失败' }));

  await harness.nodeFetch('/node/result', {
    method: 'POST',
    body: { taskId: row.task_id, ok: false, text: '', error: 'tool exploded' },
  });
  await waitFor(() => harness.queue.getRow(row.task_id).status === 'failed', { label: 'failed task' });
  assert.equal(stub.sendActions.length, 0);
  assert.equal(harness.queue.getRow(row.task_id).result_error, 'tool exploded');
});
