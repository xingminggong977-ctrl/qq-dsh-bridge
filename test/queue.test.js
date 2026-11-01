import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { openDb } from '../src/db.js';
import { DELIVERING_LEASE_MS, Queue, RUNNING_LEASE_MS, STATUS, rowToTask } from '../src/queue.js';

function makeClock(start = 1760000000000) {
  let current = start;
  return { now: () => current, advance: (ms) => (current += ms) };
}

function makeQueue({ backlogTtlMs = 1800000 } = {}) {
  const clock = makeClock();
  const db = openDb(':memory:');
  const queue = new Queue({ db, backlogTtlMs, now: clock.now });
  return { db, queue, clock };
}

const baseTask = (overrides = {}) => ({
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

test('rowToTask emits exactly the PROTOCOL Task fields', () => {
  const { queue, clock } = makeQueue();
  assert.equal(DELIVERING_LEASE_MS, 120000);
  assert.equal(RUNNING_LEASE_MS, 600000);

  const row = queue.insertTask(baseTask({ images: [{ blobId: 'b-1', mime: 'image/png', bytes: 70 }] }));
  const task = rowToTask(row);

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
  assert.equal(task.userId, '10001');
  assert.equal(task.nickname, '小明');
  assert.equal(task.text, '你好');
  assert.deepEqual(task.images, [{ blobId: 'b-1', mime: 'image/png', bytes: 70 }]);
  assert.equal(task.receivedAt, clock.now());
  assert.equal(task.deadlineAt, clock.now() + 1800000);
  assert.equal(task.isOwner, true);
  assert.equal(task.mentioned, true);
  assert.equal(task.needsReply, true);
  assert.match(task.taskId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  // replyTarget stays server-side.
  assert.equal('replyTarget' in task, false);
});

test('private tasks carry a null groupId', () => {
  const { queue } = makeQueue();
  const row = queue.insertTask(
    baseTask({ kind: 'private', groupId: null, replyTarget: { kind: 'private', userId: '10001' } }),
  );
  assert.equal(rowToTask(row).groupId, null);
});

test('claim leases a task as delivering for 120s and never double delivers', () => {
  const { queue, clock } = makeQueue();
  const row = queue.insertTask(baseTask());
  assert.equal(queue.queuedCount(), 1);

  const claimed = queue.claim({ limit: 2, at: clock.now() });
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].task_id, row.task_id);

  const stored = queue.getRow(row.task_id);
  assert.equal(stored.status, STATUS.DELIVERING);
  assert.equal(stored.lease_until, clock.now() + DELIVERING_LEASE_MS);
  assert.equal(queue.queuedCount(), 0);
  assert.deepEqual(queue.claim({ limit: 2, at: clock.now() }), []);
});

test('an expired lease returns the task to the queue', () => {
  const { queue, clock } = makeQueue();
  const row = queue.insertTask(baseTask());
  queue.claim({ limit: 1, at: clock.now() });

  clock.advance(DELIVERING_LEASE_MS); // exactly on the boundary: not expired yet
  assert.deepEqual(queue.claim({ limit: 1, at: clock.now() }), []);

  clock.advance(1);
  const reclaimed = queue.claim({ limit: 1, at: clock.now() });
  assert.equal(reclaimed.length, 1);
  assert.equal(reclaimed[0].task_id, row.task_id);
  assert.equal(queue.getRow(row.task_id).status, STATUS.DELIVERING);
});

test('tasks past their deadline are never delivered and expire instead', () => {
  const { queue, clock } = makeQueue({ backlogTtlMs: 1000 });
  queue.insertTask(baseTask());

  clock.advance(1000); // deadline_at === now: still deliverable
  assert.equal(queue.claim({ limit: 1, at: clock.now() }).length, 1);

  const second = makeQueue({ backlogTtlMs: 1000 });
  const row = second.queue.insertTask(baseTask());
  second.clock.advance(1001);
  assert.deepEqual(second.queue.claim({ limit: 1, at: second.clock.now() }), []);
  const expired = second.queue.expireOverdue(second.clock.now());
  assert.equal(expired.length, 1);
  assert.equal(second.queue.getRow(row.task_id).status, STATUS.EXPIRED);
  assert.deepEqual(second.queue.expireOverdue(second.clock.now()), []);
});

test('markRunning extends the lease to 600s and is idempotent', () => {
  const { queue, clock } = makeQueue();
  const row = queue.insertTask(baseTask());

  assert.deepEqual(queue.markRunning('missing', { at: clock.now() }), { found: false });

  const first = queue.markRunning(row.task_id, { at: clock.now() });
  assert.equal(first.found, true);
  assert.equal(first.terminal, false);
  assert.equal(first.row.status, STATUS.RUNNING);
  assert.equal(first.row.lease_until, clock.now() + RUNNING_LEASE_MS);

  const second = queue.markRunning(row.task_id, { at: clock.now() });
  assert.equal(second.found, true);
  assert.equal(second.row.status, STATUS.RUNNING);
});

test('recordResult keeps the first result and reports the rest as duplicates', () => {
  const { queue, clock } = makeQueue();
  const row = queue.insertTask(baseTask());

  assert.deepEqual(queue.recordResult('missing', { ok: true, text: 'x', at: clock.now() }), { found: false });

  const first = queue.recordResult(row.task_id, { ok: true, text: '第一次', at: clock.now() });
  assert.equal(first.found, true);
  assert.equal(first.duplicate, false);
  assert.equal(first.row.result_ok, 1);

  const second = queue.recordResult(row.task_id, { ok: false, text: '第二次', at: clock.now() });
  assert.equal(second.found, true);
  assert.equal(second.duplicate, true);
  assert.equal(second.row.result_text, '第一次');
  assert.equal(second.row.result_ok, 1);
});

test('finish moves a task to done or failed', () => {
  const { queue, clock } = makeQueue();
  const ok = queue.insertTask(baseTask());
  assert.equal(queue.finish(ok.task_id, { ok: true, at: clock.now() }).status, STATUS.DONE);
  const bad = queue.insertTask(baseTask());
  assert.equal(queue.finish(bad.task_id, { ok: false, at: clock.now() }).status, STATUS.FAILED);
});

test('a queue.db written before protocol v2 is migrated and keeps replying to old rows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bridge-migrate-'));
  const dbPath = path.join(dir, 'queue.db');

  // Exactly the v1 schema: no mentioned, no needs_reply.
  const v1 = new DatabaseSync(dbPath);
  v1.exec(`CREATE TABLE tasks (
    task_id TEXT PRIMARY KEY, kind TEXT NOT NULL, group_id TEXT, user_id TEXT NOT NULL,
    nickname TEXT NOT NULL, text TEXT NOT NULL, images TEXT NOT NULL,
    received_at INTEGER NOT NULL, deadline_at INTEGER NOT NULL, is_owner INTEGER NOT NULL,
    reply_target TEXT NOT NULL, status TEXT NOT NULL, lease_until INTEGER NOT NULL DEFAULT 0,
    result_at INTEGER, result_ok INTEGER, result_text TEXT, result_error TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);`);
  v1.prepare(
    `INSERT INTO tasks (task_id, kind, group_id, user_id, nickname, text, images, received_at,
       deadline_at, is_owner, reply_target, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    'legacy-task',
    'group',
    '123456',
    '10001',
    '小明',
    '老任务',
    '[]',
    1,
    2,
    1,
    JSON.stringify({ kind: 'group', groupId: '123456' }),
    STATUS.QUEUED,
    1,
    1,
  );
  v1.close();

  const db = openDb(dbPath);
  try {
    const columns = db.prepare('PRAGMA table_info(tasks)').all().map((column) => column.name);
    assert.deepEqual(columns.slice(-5), ['mentioned', 'needs_reply', 'proactive', 'proactive_cue', 'origin']);
    // A pre-v2 row must keep the old behaviour: it was an @ message and it expects a reply.
    const task = rowToTask(db.prepare('SELECT * FROM tasks WHERE task_id = ?').get('legacy-task'));
    assert.equal(task.mentioned, true);
    assert.equal(task.needsReply, true);
    // 迁移过来的老行都是真实来信，不能凭空变成「主动开口」。
    assert.equal(task.proactive, undefined);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
