import assert from 'node:assert/strict';
import test from 'node:test';
import { openDb } from '../src/db.js';
import { createProactivePlanner, inQuietHours, startOfDay } from '../src/proactive.js';
import { Queue, rowToTask } from '../src/queue.js';

const OWNER = '10001';

/** 固定时钟，避免测试在 23:30 或午夜附近随机翻脸。 */
function setup({ at = new Date('2026-10-25T10:00:00'), proactive = {}, ownerQq = [OWNER] } = {}) {
  const db = openDb(':memory:');
  const clock = { at };
  const now = () => clock.at.getTime();
  const queue = new Queue({ db, backlogTtlMs: 60000, now });
  const planner = createProactivePlanner({ config: { ownerQq, proactive }, queue, now, log: { info: () => {}, warn: () => {} } });
  return { db, queue, planner, clock, now };
}

test('quiet hours wrap past midnight and stop exactly on the boundary', () => {
  const at = (iso) => new Date(iso).getTime();
  assert.equal(inQuietHours(at('2026-10-25T23:30:00'), 23, 8), true);
  assert.equal(inQuietHours(at('2026-10-26T00:10:00'), 23, 8), true);
  assert.equal(inQuietHours(at('2026-10-26T07:59:00'), 23, 8), true);
  assert.equal(inQuietHours(at('2026-10-26T08:00:00'), 23, 8), false);
  assert.equal(inQuietHours(at('2026-10-25T22:59:00'), 23, 8), false);
  // from === to 表示没有安静时段，而不是「全天安静」。
  assert.equal(inQuietHours(at('2026-10-25T03:00:00'), 0, 0), false);
});

test('startOfDay lands on local midnight', () => {
  const midnight = startOfDay(new Date('2026-10-25T18:42:11').getTime());
  assert.equal(new Date(midnight).getHours(), 0);
  assert.equal(new Date(midnight).getMinutes(), 0);
  assert.equal(new Date(midnight).getSeconds(), 0);
});

test('a disabled planner or a missing owner never asks', () => {
  assert.equal(setup({ proactive: { enabled: false } }).planner.reason(), 'disabled');
  assert.equal(setup({ ownerQq: [] }).planner.reason(), 'no-owner');
  const disabled = setup({ proactive: { enabled: false } });
  assert.deepEqual(disabled.planner.ask(), { asked: false, reason: 'disabled', taskId: null });
});

test('ask queues one private, proactive task that carries no user text', () => {
  const { planner, queue, db } = setup();
  assert.equal(planner.reason(), 'ok');
  const outcome = planner.ask();
  assert.equal(outcome.asked, true);

  const rows = db.prepare('SELECT * FROM tasks').all();
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.kind, 'private');
  assert.equal(row.user_id, OWNER);
  assert.equal(row.text, '');
  assert.equal(row.proactive, 1);
  assert.equal(row.is_owner, 1);
  assert.deepEqual(JSON.parse(row.reply_target), { kind: 'private', userId: OWNER });

  // 线上协议里 proactive 只在为真时出现，老 node 看到的就是一条普通任务。
  assert.equal(rowToTask(row).proactive, true);
  assert.equal('proactive' in rowToTask({ ...row, proactive: 0 }), false);
  assert.equal(queue.lastProactiveAt(), row.created_at);
});

test('two asks cannot be closer than minGapMs', () => {
  // 这条只管间隔闸门，所以把「无新素材不问」关掉，免得它先把答案抢走。
  const { planner, clock } = setup({ proactive: { minGapMs: 10 * 60 * 1000, requireActivitySinceLastAsk: false } });
  assert.equal(planner.ask().asked, true);
  assert.equal(planner.reason(), 'gap');
  assert.deepEqual(planner.ask(), { asked: false, reason: 'gap', taskId: null });

  clock.at = new Date(clock.at.getTime() + 9 * 60 * 1000);
  assert.equal(planner.reason(), 'gap');
  clock.at = new Date(clock.at.getTime() + 61 * 1000);
  assert.equal(planner.reason(), 'ok');
});

test('the daily allowance counts delivered messages, not asks', () => {
  const { planner, queue, now } = setup({ proactive: { maxPerDay: 2 } });

  const first = planner.ask();
  const second = planner.ask() ?? {};
  // 第一问被接受之后立刻就是 gap，这里直接以「已发出」的形式记结果。
  queue.recordResult(first.taskId, { ok: true, text: '今天看到一只猫' });
  // 用被测的时钟，不是真实 Date.now()：这个用例的时钟固定在 2026-10-25，\
  // 拿真实时间算当天零点，一过零点断言就会翻脸。
  assert.equal(queue.countProactiveSent(startOfDay(now())), 1);

  // 弃权（正文为空）不能吃掉额度，这正是 NONE 承诺的东西。
  const declined = planner.ask();
  assert.equal(declined.asked, false, 'gap still applies right after one ask');
  assert.ok(second.reason === 'gap' || second.reason === 'ok');

  const third = queue.insertTask({
    kind: 'private',
    userId: OWNER,
    nickname: '',
    text: '',
    images: [],
    isOwner: true,
    replyTarget: { kind: 'private', userId: OWNER },
    proactive: true,
  });
  queue.recordResult(third.task_id, { ok: true, text: '' });
  assert.equal(queue.countProactiveSent(startOfDay(now())), 1, 'an empty reply sends nothing');
});

test('quota and quiet hours both veto the ask', () => {
  const quota = setup({ proactive: { maxPerDay: 1, minGapMs: 60000 } });
  const first = quota.planner.ask();
  quota.queue.recordResult(first.taskId, { ok: true, text: '在' });
  assert.equal(quota.planner.reason(), 'quota');

  const night = setup({ at: new Date('2026-10-25T23:40:00') });
  assert.equal(night.planner.reason(), 'quiet');
});

test('the day quota is spent across the day, not all before lunch', () => {
  const at = new Date('2026-10-25T11:00:00');
  const { planner, queue, clock } = setup({ at, proactive: { maxPerDay: 4, maxAsksPerDay: 99, minGapMs: 0, requireActivitySinceLastAsk: false } });

  // 上午已经发了两条，第三条要等额度按时间放开。
  for (const text of ['早', '在忙什么']) {
    const asked = planner.ask();
    queue.recordResult(asked.taskId, { ok: true, text });
  }
  assert.equal(queue.countProactiveSent(startOfDay(clock.at.getTime())), 2);
  assert.equal(planner.reason(), 'quota', '上午不该把 4 条全用完');
  assert.match(planner.describeReason(), /留着晚上说/);

  // 到了晚上，同样的两条不再是上限。
  clock.at = new Date('2026-10-25T20:00:00');
  assert.equal(planner.reason(), 'ok');
});
