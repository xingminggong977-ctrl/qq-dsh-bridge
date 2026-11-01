import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { PNG_BASE64, OWNER_QQ, SELF_ID, startImageServer, startWithNapCat } from './helpers/harness.js';
import { atSegment, groupMessage, imageSegment, textSegment } from './helpers/ws-stub.js';
import { sleep, waitFor } from './helpers/wait.js';

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const bear = (harness) => ({ authorization: `Bearer ${harness.config.nodeToken}` });

/**
 * Acceptance 2 + 6 end to end: NapCat event -> queue.db -> long poll -> blob -> result -> QQ.
 * Every hop is logged as a diagnostic so the transcript doubles as hand-off evidence.
 */
test('group @ message round trip: napcat -> sqlite -> poll -> result -> QQ', async (t) => {
  const imageServer = await startImageServer();
  t.after(() => imageServer.stop());
  const { stub, harness } = await startWithNapCat(t);

  const transcript = [];
  const record = (step, detail) => {
    transcript.push({ step, ...detail });
    t.diagnostic(JSON.stringify({ step, ...detail }));
  };

  // 1. NapCat pushes a group message that @s the bot and carries an image.
  const event = groupMessage({
    selfId: SELF_ID,
    groupId: '123456',
    userId: OWNER_QQ,
    nickname: '小明',
    segments: [atSegment(SELF_ID), textSegment(' 帮我看看这张图 '), imageSegment(imageServer.url)],
  });
  stub.inject(event);
  await waitFor(() => harness.queue.queuedCount() === 1, { label: 'task queued from napcat event' });
  const [dbRow] = harness.queue.db.prepare('SELECT * FROM tasks').all();
  record('1 napcat -> bridge (ws text frame)', { self_id: event.self_id, message: event.message });
  record('2 bridge -> sqlite queue.db', {
    task_id: dbRow.task_id,
    kind: dbRow.kind,
    group_id: dbRow.group_id,
    user_id: dbRow.user_id,
    text: dbRow.text,
    images: JSON.parse(dbRow.images),
    status: dbRow.status,
    ttl_ms: dbRow.deadline_at - dbRow.received_at,
  });
  assert.equal(dbRow.text, '帮我看看这张图');
  assert.equal(JSON.parse(dbRow.images).length, 1);

  // 2. Health is public.
  const health = await harness.nodeFetch('/health', { auth: false });
  record('3 GET /health', { status: health.status, body: health.body });
  assert.deepEqual(health.body, { ok: true, queued: 1, uptimeMs: health.body.uptimeMs, napcat: 'up' });

  // 3. The local node long-polls and receives the leased task.
  const poll = await harness.nodeFetch('/node/poll?wait=5&limit=2');
  const task = poll.body.tasks[0];
  record('4 GET /node/poll?wait=5&limit=2', { status: poll.status, body: poll.body });
  assert.equal(poll.status, 200);
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
  assert.equal(task.kind, 'group');
  assert.equal(task.groupId, '123456');
  assert.equal(task.userId, OWNER_QQ);
  assert.equal(task.nickname, '小明');
  assert.equal(task.text, '帮我看看这张图');
  assert.equal(task.isOwner, true);
  assert.equal(task.mentioned, true);
  assert.equal(task.needsReply, true);
  assert.equal(task.deadlineAt - task.receivedAt, 1800000);
  assert.equal(harness.queue.getRow(task.taskId).status, 'delivering');
  assert.equal(task.images.length, 1);
  assert.equal(task.images[0].mime, 'image/png');
  assert.equal(task.images[0].bytes, Buffer.from(PNG_BASE64, 'base64').length);

  // 4. The blob comes back byte for byte.
  const blob = await fetch(`${harness.base}/blob/${task.images[0].blobId}`, { headers: bear(harness) });
  const blobBytes = Buffer.from(await blob.arrayBuffer());
  record('5 GET /blob/<blobId>', {
    status: blob.status,
    content_type: blob.headers.get('content-type'),
    bytes: blobBytes.length,
    sha256: sha256(blobBytes),
    matches_source_image: sha256(blobBytes) === sha256(imageServer.bytes),
  });
  assert.equal(blob.status, 200);
  assert.equal(blob.headers.get('content-type'), 'image/png');
  assert.equal(sha256(blobBytes), sha256(imageServer.bytes));

  // 5. The node accepts the task, then reports the answer.
  const accepted = await harness.nodeFetch('/node/status', {
    method: 'POST',
    body: { taskId: task.taskId, state: 'accepted' },
  });
  record('6 POST /node/status {state:accepted}', { status: accepted.status, body: accepted.body });
  assert.equal(accepted.status, 200);

  const answer = '看到了，图里是一只红色的点。';
  const result = await harness.nodeFetch('/node/result', {
    method: 'POST',
    body: { taskId: task.taskId, ok: true, text: answer, error: '' },
  });
  record('7 POST /node/result', { status: result.status, body: result.body });
  assert.deepEqual(result.body, { ok: true });

  // 6. The bridge sends it back through NapCat.
  await waitFor(() => stub.sendActions.length === 1, { label: 'reply sent to napcat' });
  record('8 bridge -> napcat action', {
    action: stub.sendActions[0].action,
    params: stub.sendActions[0].params,
    echo_is_uuid: /^[0-9a-f-]{36}$/.test(String(stub.sendActions[0].echo)),
  });
  assert.equal(stub.sendActions[0].action, 'send_group_msg');
  assert.equal(stub.sendActions[0].params.group_id, 123456);
  assert.deepEqual(stub.sendActions[0].params.message, [{ type: 'text', data: { text: answer } }]);

  await waitFor(() => harness.queue.getRow(task.taskId).status === 'done', { label: 'task done' });
  record('9 sqlite final state', {
    status: harness.queue.getRow(task.taskId).status,
    result_ok: harness.queue.getRow(task.taskId).result_ok,
    result_text: harness.queue.getRow(task.taskId).result_text,
  });

  // 7. A repeated result is acknowledged but never re-sent.
  const duplicate = await harness.nodeFetch('/node/result', {
    method: 'POST',
    body: { taskId: task.taskId, ok: true, text: '重复投递' },
  });
  record('10 duplicate POST /node/result', { status: duplicate.status, body: duplicate.body });
  await sleep(100);
  assert.deepEqual(duplicate.body, { ok: true, duplicate: true });
  assert.equal(stub.sendActions.length, 1);

  assert.equal(transcript.length, 10);
});
