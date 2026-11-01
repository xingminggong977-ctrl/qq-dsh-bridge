import assert from 'node:assert/strict';
import test from 'node:test';

import { EXPIRED_NOTICE } from '../src/dispatch.js';
import { SELF_ID, startWithNapCat } from './helpers/harness.js';
import { atSegment, groupMessage, privateMessage, textSegment } from './helpers/ws-stub.js';
import { sleep, waitFor } from './helpers/wait.js';

const pollOnce = (harness) => harness.nodeFetch('/node/poll?wait=1&limit=1');
const taskCount = (harness) => harness.queue.db.prepare('SELECT COUNT(*) AS c FROM tasks').get().c;
const unMentioned = (overrides = {}) => ({
  selfId: SELF_ID,
  segments: [textSegment('今天天气不错')],
  ...overrides,
});
const mention = (overrides = {}) => ({
  selfId: SELF_ID,
  segments: [atSegment(SELF_ID), textSegment(' 在吗 ')],
  ...overrides,
});

test('GROUP_MODE=mention (the default) drops group messages that never @ the bot', async (t) => {
  const { stub, harness } = await startWithNapCat(t);
  assert.equal(harness.config.groupMode, 'mention');

  stub.inject(groupMessage(unMentioned()));
  await sleep(150);
  assert.equal(taskCount(harness), 0);
  assert.equal(harness.queue.queuedCount(), 0);

  // Control: the same pipeline still queues an @ message, so the drop above is the rule at work.
  stub.inject(groupMessage(mention()));
  await waitFor(() => harness.queue.queuedCount() === 1, { label: 'mentioned task queued' });
  assert.equal(taskCount(harness), 1);
  assert.deepEqual(stub.sentTexts, []);
});

test('GROUP_MODE=all queues un-mentioned group chatter as context (mentioned:false, needsReply:false)', async (t) => {
  const { stub, harness } = await startWithNapCat(t, { env: { GROUP_MODE: 'all' } });
  assert.equal(harness.config.groupMode, 'all');

  stub.inject(groupMessage(unMentioned()));
  await waitFor(() => harness.queue.queuedCount() === 1, { label: 'un-mentioned task queued' });

  const poll = await pollOnce(harness);
  assert.equal(poll.body.tasks.length, 1);
  const [task] = poll.body.tasks;
  assert.equal(task.kind, 'group');
  assert.equal(task.groupId, '123456');
  assert.equal(task.text, '今天天气不错');
  assert.equal(task.mentioned, false);
  assert.equal(task.needsReply, false);
  assert.equal(harness.queue.getRow(task.taskId).needs_reply, 0);
});

test('GROUP_MODE=all still marks an @ message as mentioned and reply-worthy', async (t) => {
  const { stub, harness } = await startWithNapCat(t, { env: { GROUP_MODE: 'all' } });

  stub.inject(groupMessage(mention()));
  await waitFor(() => harness.queue.queuedCount() === 1, { label: 'mentioned task queued' });

  const poll = await pollOnce(harness);
  const [task] = poll.body.tasks;
  assert.equal(task.kind, 'group');
  assert.equal(task.mentioned, true);
  assert.equal(task.needsReply, true);
});

test('private chat is unchanged under GROUP_MODE=all: always mentioned, always needs a reply', async (t) => {
  const { stub, harness } = await startWithNapCat(t, { env: { GROUP_MODE: 'all' } });

  stub.inject(privateMessage({ userId: '20002', segments: [textSegment('私聊你好')] }));
  await waitFor(() => harness.queue.queuedCount() === 1, { label: 'private task queued' });

  const poll = await pollOnce(harness);
  const [task] = poll.body.tasks;
  assert.equal(task.kind, 'private');
  assert.equal(task.groupId, null);
  assert.equal(task.text, '私聊你好');
  assert.equal(task.mentioned, true);
  assert.equal(task.needsReply, true);
});

test('a needsReply:false task expires silently, with no EXPIRED_NOTICE in QQ', async (t) => {
  const { stub, harness } = await startWithNapCat(t, { env: { GROUP_MODE: 'all' } });

  stub.inject(groupMessage(unMentioned()));
  await waitFor(() => harness.queue.queuedCount() === 1, { label: 'context task queued' });
  const [row] = harness.queue.db.prepare('SELECT * FROM tasks').all();
  assert.equal(row.needs_reply, 0);

  harness.clock.advance(1800001); // past the 30 minute backlog TTL
  const response = await harness.nodeFetch('/node/poll?wait=0&limit=1');
  assert.deepEqual(response.body.tasks, []);
  assert.equal(harness.queue.getRow(row.task_id).status, 'expired');

  // The behaviour under test: nothing is pushed to QQ, not even the fixed notice.
  await harness.dispatch.whenSettled(`expired:${row.task_id}`);
  await sleep(150);
  assert.equal(stub.sendActions.length, 0);
  assert.deepEqual(stub.sentTexts, []);
  assert.equal(stub.sentTexts.includes(EXPIRED_NOTICE), false);
});

test('a needsReply:true task expiring still gets the fixed notice', async (t) => {
  const { stub, harness } = await startWithNapCat(t, { env: { GROUP_MODE: 'all' } });

  stub.inject(groupMessage(mention()));
  await waitFor(() => harness.queue.queuedCount() === 1, { label: 'mentioned task queued' });
  const [row] = harness.queue.db.prepare('SELECT * FROM tasks').all();
  assert.equal(row.needs_reply, 1);

  harness.clock.advance(1800001);
  assert.deepEqual((await harness.nodeFetch('/node/poll?wait=1&limit=1')).body.tasks, []);
  await waitFor(() => stub.sentTexts.length === 1, { label: 'expiry notice' });
  assert.deepEqual(stub.sentTexts, [EXPIRED_NOTICE]);
});

test('an empty result is finished as done without touching QQ or the rate limiter', async (t) => {
  const { stub, harness } = await startWithNapCat(t, { env: { GROUP_MODE: 'all' } });

  stub.inject(groupMessage(mention()));
  await waitFor(() => harness.queue.queuedCount() === 1, { label: 'task queued' });
  const [task] = (await pollOnce(harness)).body.tasks;
  assert.equal(task.needsReply, true);

  const rateEventsBefore = harness.queue.db.prepare('SELECT COUNT(*) AS c FROM rate_events').get().c;
  const response = await harness.nodeFetch('/node/result', {
    method: 'POST',
    body: { taskId: task.taskId, ok: true, text: '' },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ok: true });

  await waitFor(() => harness.queue.getRow(task.taskId).status === 'done', { label: 'task done' });
  await sleep(150);
  assert.equal(stub.sendActions.length, 0);
  assert.deepEqual(stub.sentTexts, []);
  // Empty replies never spend the caller's rate budget.
  assert.equal(harness.queue.db.prepare('SELECT COUNT(*) AS c FROM rate_events').get().c, rateEventsBefore);

  const row = harness.queue.getRow(task.taskId);
  assert.equal(row.result_ok, 1);
  assert.equal(row.result_text, '');
});
