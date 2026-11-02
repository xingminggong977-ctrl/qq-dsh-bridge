import assert from 'node:assert/strict';
import test from 'node:test';

import { openDb } from '../src/db.js';
import { createReminderStore, createReminderTicker, REMINDER_GRACE_MS } from '../src/reminders.js';

const quiet = { info() {}, warn() {}, error() {} };

function store(now = () => 1_800_000_000_000) {
  const db = openDb(':memory:');
  return { db, reminders: createReminderStore({ db, log: quiet, now }) };
}

test('add() keeps the text one line and rejects times that cannot be honoured', () => {
  const now = () => 1_800_000_000_000;
  const { reminders } = store(now);

  const made = reminders.add({ at: now() + 60_000, text: ' 给爸爸\n打电话 ', target: '{"kind":"private","userId":"10001"}' });
  assert.equal(made.text, '给爸爸 打电话', '换行会被压成空格');

  assert.throws(() => reminders.add({ at: now() - 1, text: '过去', target: '{}' }), /已经过去/);
  assert.throws(() => reminders.add({ at: now() + 40 * 24 * 3600_000, text: '太远', target: '{}' }), /太远/);
  assert.throws(() => reminders.add({ at: now() + 60_000, text: '   ', target: '{}' }), /提醒什么/);
});

test('the same reminder asked for twice is stored once and handed back as a duplicate', () => {
  const clock = 1_800_000_000_000;
  const { reminders } = store(() => clock);
  const target = '{"kind":"private","userId":"10001"}';
  const at = clock + 12 * 3600_000;

  const first = reminders.add({ at, text: '七点了，记得给爸爸打个电话呀。', target });
  // 线上真发生过：她自己排过一次，第二天早上又不放心地排了一遍。
  const again = reminders.add({ at, text: '七点了，记得给爸爸打个电话呀。', target });
  assert.equal(again.duplicate, true, '第二遍要说是重复');
  assert.equal(again.reminderId, first.reminderId, '重复时把已有的那条还回去');
  assert.equal(reminders.pending(clock).length, 1, '到点只说一次');

  // 差一点点的同一句话（比如她自己改了口径）不算重复。
  const shifted = reminders.add({ at: at + 10 * 60_000, text: '七点了，记得给爸爸打个电话呀。', target });
  assert.equal(shifted.duplicate, undefined, '差了十分钟是新的一条');
  assert.notEqual(shifted.reminderId, first.reminderId);
  assert.equal(reminders.pending(clock).length, 2);
});

test('due() hands back only what is due, and expires stale rows instead of firing them', () => {
  let clock = 1_800_000_000_000;
  const now = () => clock;
  const { reminders } = store(now);
  const target = '{"kind":"private","userId":"1"}';

  reminders.add({ at: clock + 9_000, text: '还没到', target });
  reminders.add({ at: clock + 3_000, text: '刚到', target });

  clock += 5_000;
  assert.deepEqual(reminders.due(clock).map((row) => row.text), ['刚到'], '只拿到点的那条');

  // 一条早就过期的：不补发，直接判死。
  const db = openDb(':memory:');
  const stale = createReminderStore({ db, log: quiet, now });
  const longAgo = now() - REMINDER_GRACE_MS - 20 * 60_000;
  stale.add({ at: longAgo + 5 * 60_000, text: '早就过去了', target, atNow: longAgo });
  assert.deepEqual(stale.due(now()), [], '过期的不发');
});

test('the ticker sends each reminder once and marks it fired', async () => {
  const now = () => 1_800_000_000_000;
  const { reminders } = store(now);
  const sent = [];
  const ticker = createReminderTicker({
    store: reminders,
    log: quiet,
    now,
    sendText: async (target, text) => { sent.push({ target, text }); },
  });

  reminders.add({ at: now() - 1_000, text: '给爸爸打电话', target: '{"kind":"private","userId":"10001"}', atNow: now() - 10_000 });
  await ticker.tick();
  await ticker.tick();

  assert.deepEqual(sent, [{ target: { kind: 'private', userId: '10001' }, text: '给爸爸打电话' }], '只发一次');
  assert.deepEqual(reminders.pending(now()), [], '发过的不再挂着');
});

test('a reminder whose send blows up is dropped, not retried forever', async () => {
  const now = () => 1_800_000_000_000;
  const { reminders } = store(now);
  let calls = 0;
  const ticker = createReminderTicker({
    store: reminders,
    log: quiet,
    now,
    sendText: async () => { calls += 1; throw new Error('onebot down'); },
  });

  reminders.add({ at: now() - 1_000, text: '喊一声', target: '{"kind":"private","userId":"1"}', atNow: now() - 10_000 });
  await ticker.tick();
  await ticker.tick();

  assert.equal(calls, 1, '失败也只尝试一次');
});
