import assert from 'node:assert/strict';
import test from 'node:test';

import { EXPIRED_NOTICE } from '../src/dispatch.js';
import { SELF_ID, groupTask, startWithNapCat } from './helpers/harness.js';
import { atSegment, groupMessage, textSegment } from './helpers/ws-stub.js';
import { sleep, waitFor } from './helpers/wait.js';

const pollOnce = (harness) => harness.nodeFetch('/node/poll?wait=0&limit=1');

test('a delivered task comes back after its 120s lease expires', async (t) => {
  const { harness } = await startWithNapCat(t);
  const row = harness.queue.insertTask(groupTask());

  const first = await pollOnce(harness);
  assert.equal(first.body.tasks.length, 1);
  assert.equal(first.body.tasks[0].taskId, row.task_id);
  assert.equal(harness.queue.getRow(row.task_id).status, 'delivering');

  // Inside the lease the task must not be handed out twice.
  assert.deepEqual((await pollOnce(harness)).body.tasks, []);

  harness.clock.advance(120000); // lease_until === now: still leased
  assert.deepEqual((await pollOnce(harness)).body.tasks, []);

  harness.clock.advance(1); // lease expired -> back to queued -> delivered again
  const again = await pollOnce(harness);
  assert.equal(again.body.tasks.length, 1);
  assert.equal(again.body.tasks[0].taskId, row.task_id);
  assert.equal(harness.queue.getRow(row.task_id).status, 'delivering');
});

test('a task stuck in running is reclaimed after its 600s lease', async (t) => {
  const { harness } = await startWithNapCat(t);
  const row = harness.queue.insertTask(groupTask());
  await pollOnce(harness);
  const accepted = await harness.nodeFetch('/node/status', {
    method: 'POST',
    body: { taskId: row.task_id, state: 'accepted' },
  });
  assert.equal(accepted.status, 200);
  assert.equal(harness.queue.getRow(row.task_id).status, 'running');

  harness.clock.advance(600000);
  assert.deepEqual((await pollOnce(harness)).body.tasks, []);
  harness.clock.advance(1);
  const again = await pollOnce(harness);
  assert.equal(again.body.tasks[0].taskId, row.task_id);
});

test('backlog older than the TTL is skipped instead of delivered', async (t) => {
  const { stub, harness } = await startWithNapCat(t);

  stub.inject(groupMessage({ selfId: SELF_ID, segments: [atSegment(SELF_ID), textSegment('五分钟后才看到')] }));
  await waitFor(() => harness.queue.queuedCount() === 1, { label: 'queued task' });
  const [row] = harness.queue.db.prepare('SELECT * FROM tasks').all();

  harness.clock.advance(1800001); // past the 30 minute backlog TTL
  const response = await harness.nodeFetch('/node/poll?wait=1&limit=1');
  assert.deepEqual(response.body.tasks, []);
  assert.equal(harness.queue.getRow(row.task_id).status, 'expired');

  await waitFor(() => stub.sentTexts.length === 1, { label: 'expiry notice' });
  assert.deepEqual(stub.sentTexts, [EXPIRED_NOTICE]);

  // Repeated polls must not spam the user.
  await pollOnce(harness);
  await sleep(80);
  assert.equal(stub.sentTexts.length, 1);
});
