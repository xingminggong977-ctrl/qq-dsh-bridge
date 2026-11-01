import assert from 'node:assert/strict';
import test from 'node:test';

import { startWithNapCat } from './helpers/harness.js';
import { waitFor } from './helpers/wait.js';

const FAST = { sendBackoffMs: [1, 1, 1], segmentDelayMs: 0, pollSliceMs: 25, slowAckMs: 120 };
const ACK = '在呢，我想一下。';

function ownerTask(overrides = {}) {
  return {
    kind: 'private',
    userId: '10001',
    nickname: '主人',
    text: '在吗',
    images: [],
    isOwner: true,
    mentioned: true,
    needsReply: true,
    replyTarget: { kind: 'private', userId: '10001' },
    ...overrides,
  };
}

/**
 * 取走一条任务并把它标成 running —— 这才是「她已经在想」的状态。
 *
 * 只取不标（`status` 还停在 `delivering`）表示 node 那一侧还在等并发槽，
 * 垫话要换成「前面那条还在弄」那一套（见 queued 用例）。
 */
async function claimOne(harness) {
  const polled = await harness.nodeFetch('/node/poll?wait=0');
  for (const task of polled.body.tasks) {
    await harness.nodeFetch('/node/status', { method: 'POST', body: { taskId: task.taskId, state: 'running' } });
  }
  return polled;
}

test('a slow turn gets one short ack instead of three minutes of silence', async (t) => {
  const { stub, harness } = await startWithNapCat(t, { timing: FAST });
  harness.queue.insertTask(ownerTask());

  const polled = await claimOne(harness);
  assert.equal(polled.body.tasks.length, 1, '任务被取走');

  await waitFor(() => stub.sentTexts.includes(ACK), { label: 'slow ack', timeoutMs: 4000 });
  // 再等一轮，确认它只垫一次。
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(stub.sentTexts, [ACK], '垫话只发一次');
});

test('a result that lands in time never triggers the ack', async (t) => {
  const { stub, harness } = await startWithNapCat(t, { timing: FAST });
  const row = harness.queue.insertTask(ownerTask());
  await claimOne(harness);

  await harness.nodeFetch('/node/result', { method: 'POST', body: { taskId: row.task_id, ok: true, text: '在呢。' } });
  await waitFor(() => stub.sentTexts.includes('在呢。'), { label: 'real reply' });

  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.deepEqual(stub.sentTexts, ['在呢。'], '结果先到时不该冒出垫话');
});

test('proactive and ask rows are never acked', async (t) => {
  const { stub, harness } = await startWithNapCat(t, { timing: FAST });
  harness.queue.insertTask(ownerTask({ proactive: true, text: '她主动开口' }));
  await claimOne(harness);
  harness.queue.insertTask(ownerTask({ origin: 'ask', text: '别人问一句' }));
  await claimOne(harness);

  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.deepEqual(stub.sentTexts, [], '主动开口和 ask 都不垫话');
});

test('a private turn that dies with no text says so instead of going silent', async (t) => {
  const { stub, harness } = await startWithNapCat(t, { timing: FAST });
  const row = harness.queue.insertTask(ownerTask());
  await claimOne(harness);

  await harness.nodeFetch('/node/result', {
    method: 'POST',
    body: { taskId: row.task_id, ok: false, text: '', error: 'llm-deepseek: connection reset' },
  });

  await waitFor(() => stub.sentTexts.includes('我这边卡了一下，你再说一次好吗？'), { label: 'failure notice' });
  await waitFor(() => harness.queue.getRow(row.task_id).status === 'failed', { label: 'task settled as failed' });
});

test('a timed-out turn asks her to continue instead of pretending the turn crashed', async (t) => {
  const { stub, harness } = await startWithNapCat(t, { timing: FAST });
  const row = harness.queue.insertTask(ownerTask());
  await claimOne(harness);

  await harness.nodeFetch('/node/result', {
    method: 'POST',
    body: { taskId: row.task_id, ok: false, text: '', error: 'turn timeout' },
  });

  await waitFor(() => stub.sentTexts.includes('这事儿比我想的费时间，我先停在这儿了。你说句「继续」，我接着弄。'), {
    label: 'timeout notice',
  });
  assert.ok(!stub.sentTexts.includes('我这边卡了一下，你再说一次好吗？'), '超时不要用「卡了」那句');
  await waitFor(() => harness.queue.getRow(row.task_id).status === 'failed', { label: 'task settled as failed' });
});

const LADDER = { ...FAST, slowAckMs: 100, slowLateMs: 350, slowDeepMs: 700 };
const QUEUED = '前面那条我还在弄，你这条我记下了，稍等一下就到。';
const LATE = '还在弄，别急，一会儿就说。';
const DEEP = '这条比平时长，我还在弄。';

test('a turn that runs past a minute and a half says 「还在弄」 once, after the first ack', async (t) => {
  const { stub, harness } = await startWithNapCat(t, { timing: LADDER });
  harness.queue.insertTask(ownerTask());
  await claimOne(harness);

  await waitFor(() => stub.sentTexts.includes(ACK), { label: 'first ack', timeoutMs: 4000 });
  await waitFor(() => stub.sentTexts.includes(LATE), { label: 'late ack', timeoutMs: 4000 });
  await waitFor(() => stub.sentTexts.includes(DEEP), { label: 'deep ack', timeoutMs: 4000 });
  assert.deepEqual(stub.sentTexts, [ACK, LATE, DEEP], '三句垫话，顺序固定，各一次');

  // 再等一轮：轮询会再看到同一条任务，但不能重新排一次垫话。
  await new Promise((resolve) => setTimeout(resolve, 500));
  await claimOne(harness);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.deepEqual(stub.sentTexts, [ACK, LATE, DEEP], '不再重复垫话');
});

test('a reply that lands between the two acks cancels 「还在弄」', async (t) => {
  const { stub, harness } = await startWithNapCat(t, { timing: LADDER });
  const row = harness.queue.insertTask(ownerTask());
  await claimOne(harness);

  await waitFor(() => stub.sentTexts.includes(ACK), { label: 'first ack', timeoutMs: 4000 });
  await harness.nodeFetch('/node/result', { method: 'POST', body: { taskId: row.task_id, ok: true, text: '在呢。' } });
  await waitFor(() => stub.sentTexts.includes('在呢。'), { label: 'real reply' });

  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.deepEqual(stub.sentTexts, [ACK, '在呢。'], '回复到了就不再补第二句');
});

test('a reply that lands after the second ack still cancels the third', async (t) => {
  const { stub, harness } = await startWithNapCat(t, { timing: LADDER });
  const row = harness.queue.insertTask(ownerTask());
  await claimOne(harness);

  await waitFor(() => stub.sentTexts.includes(LATE), { label: 'late ack', timeoutMs: 4000 });
  await harness.nodeFetch('/node/result', { method: 'POST', body: { taskId: row.task_id, ok: true, text: '弄好了。' } });
  await waitFor(() => stub.sentTexts.includes('弄好了。'), { label: 'real reply' });

  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.deepEqual(stub.sentTexts, [ACK, LATE, '弄好了。'], '第三句不该再冒出来');
});


test('once she speaks for herself, the canned ladder stays quiet', async (t) => {
  const { stub, harness } = await startWithNapCat(t, { timing: LADDER });
  const row = harness.queue.insertTask(ownerTask());
  await claimOne(harness);

  // 节点在 75 秒（这里压到 30 毫秒）先发一句真话，并把 taskId 带上。
  await harness.nodeFetch('/node/send', {
    method: 'POST',
    body: { to: '10001', text: '我先看了一眼那张图。', taskId: row.task_id },
  });
  await waitFor(() => stub.sentTexts.includes('我先看了一眼那张图。'), { label: 'early sentence' });

  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.deepEqual(stub.sentTexts, ['我先看了一眼那张图。'], '她自己开口了就不再补罐头垫话');

  // 轮询会再看到同一条任务，也不能重新排一次。
  await claimOne(harness);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.deepEqual(stub.sentTexts, ['我先看了一眼那张图。'], '再轮询一次也不重排');
});

test('a task still waiting for a slot says it is queued, not that she is thinking', async (t) => {
  const { stub, harness } = await startWithNapCat(t, { timing: LADDER });
  harness.queue.insertTask(ownerTask());
  // 只取走、不标 running：node 那一侧还在等并发槽，这正是线上排过 187 秒的状态。
  await harness.nodeFetch('/node/poll?wait=0');

  await waitFor(() => stub.sentTexts.includes(QUEUED), { label: 'queued ack', timeoutMs: 4000 });
  assert.ok(!stub.sentTexts.includes(ACK), '排队时不能说「我想一下」');
});

test('an early sentence without a taskId does not silence the ladder', async (t) => {
  const { stub, harness } = await startWithNapCat(t, { timing: LADDER });
  harness.queue.insertTask(ownerTask());
  await claimOne(harness);

  await harness.nodeFetch('/node/send', { method: 'POST', body: { to: '10001', text: '顺手发一句。' } });
  await waitFor(() => stub.sentTexts.includes('顺手发一句。'), { label: 'unrelated send' });
  await waitFor(() => stub.sentTexts.includes(ACK), { label: 'ack still fires', timeoutMs: 4000 });
  assert.ok(stub.sentTexts.includes(ACK), '没有 taskId 的发送跟这条任务的垫话无关');
});
