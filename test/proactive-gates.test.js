import assert from 'node:assert/strict';
import test from 'node:test';
import { openDb } from '../src/db.js';
import { PROACTIVE_DEFAULTS, PROACTIVE_REASONS, createProactivePlanner, startOfDay } from '../src/proactive.js';
import { Queue } from '../src/queue.js';

const OWNER = '10001';
const MIN = 60 * 1000;

/** 固定时钟：2026-10-25 10:00 本地时间，不在安静时段，也不贴着零点。 */
function setup({ at = new Date('2026-10-25T10:00:00'), proactive = {}, ownerQq = [OWNER] } = {}) {
  const db = openDb(':memory:');
  const clock = { at };
  const now = () => clock.at.getTime();
  const queue = new Queue({ db, backlogTtlMs: 60000, now });
  const planner = createProactivePlanner({
    config: { ownerQq, proactive },
    queue,
    now,
    log: { info: () => {}, warn: () => {} },
  });
  const advance = (ms) => {
    clock.at = new Date(clock.at.getTime() + ms);
  };
  const say = (text = '在吗', isOwner = true) =>
    queue.insertTask({
      kind: 'private',
      userId: isOwner ? OWNER : '999999',
      nickname: '',
      text,
      images: [],
      isOwner,
      replyTarget: { kind: 'private', userId: isOwner ? OWNER : '999999' },
    });
  return { db, queue, planner, clock, now, advance, say };
}

test('新默认值：90 分钟间隔、每日 8 次询问、默认要求新素材', () => {
  assert.equal(PROACTIVE_DEFAULTS.minGapMs, 90 * MIN);
  assert.equal(PROACTIVE_DEFAULTS.maxAsksPerDay, 8);
  assert.equal(PROACTIVE_DEFAULTS.requireActivitySinceLastAsk, true);
  // 发送额度还在，含义没变：问 8 次不代表发得出 8 条。
  assert.equal(PROACTIVE_DEFAULTS.maxPerDay, 30);
});

test('reason() 只返回枚举里的稳定字符串', () => {
  assert.deepEqual([...PROACTIVE_REASONS].sort(), [
    'asked-quota',
    'disabled',
    'gap',
    'no-activity',
    'no-owner',
    'ok',
    'quiet',
    'quota',
  ]);
  const seen = [
    setup().planner.reason(),
    setup({ proactive: { enabled: false } }).planner.reason(),
    setup({ ownerQq: [] }).planner.reason(),
    setup({ at: new Date('2026-10-25T23:40:00') }).planner.reason(),
  ];
  for (const why of seen) assert.ok(PROACTIVE_REASONS.includes(why), `${why} 不在枚举里`);
});

test('从没问过的时候，「无新素材」不挡第一次开口', () => {
  const { planner } = setup();
  assert.equal(planner.reason(), 'ok');
  assert.equal(planner.ask().asked, true);
});

test('上次问过之后什么都没发生：no-activity，不入队', () => {
  const { planner, advance, db } = setup();
  assert.equal(planner.ask().asked, true);
  advance(95 * MIN);
  assert.equal(planner.reason(), 'no-activity');
  assert.deepEqual(planner.ask(), { asked: false, reason: 'no-activity', taskId: null });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 1, '只有第一次那条询问');
});

test('主人说了新话就是新素材', () => {
  const { planner, advance, say } = setup();
  planner.ask();
  advance(95 * MIN);
  say('刚到家');
  assert.equal(planner.reason(), 'ok');
  assert.equal(planner.ask().asked, true);
});

test('一条任务真的跑完也算新素材', () => {
  const { planner, advance, say, queue } = setup();
  const inbound = say('帮我记一下明早九点开会');
  planner.ask(); // 询问发生在入站消息之后，所以只有「完成」这一个素材来源
  advance(95 * MIN);
  queue.recordResult(inbound.task_id, { ok: true, text: '记下了' });
  assert.equal(planner.reason(), 'ok');
});

test('她自己上一轮的弃权不算新素材', () => {
  const { planner, advance, queue } = setup();
  const asked = planner.ask();
  advance(95 * MIN);
  // NONE 也是这一轮的「结果」，那不是别人干了什么，不能拿它给自己续命。
  queue.recordResult(asked.taskId, { ok: true, text: '' });
  assert.equal(planner.reason(), 'no-activity');
});

test('当天询问额度用尽：asked-quota', () => {
  const { planner, advance } = setup({
    proactive: { maxAsksPerDay: 3, minGapMs: MIN, requireActivitySinceLastAsk: false },
  });
  for (let i = 0; i < 3; i += 1) {
    assert.equal(planner.ask().asked, true, `第 ${i + 1} 次询问应该被接受`);
    advance(2 * MIN);
  }
  assert.equal(planner.asksToday(), 3);
  assert.equal(planner.reason(), 'asked-quota');
});

test('发送额度与询问额度互不影响', () => {
  // 一发出去就到发送上限，但询问次数只有 1：卡住的是 quota，不是 asked-quota。
  const sent = setup({ proactive: { maxPerDay: 1, maxAsksPerDay: 8, minGapMs: MIN, requireActivitySinceLastAsk: false } });
  const first = sent.planner.ask();
  sent.queue.recordResult(first.taskId, { ok: true, text: '今天看到一只猫' });
  assert.equal(sent.planner.reason(), 'quota');

  // 问了但回 NONE（一条也没发出去），发送额度还剩着，卡住的是 asked-quota。
  const silent = setup({ proactive: { maxPerDay: 30, maxAsksPerDay: 1, minGapMs: MIN, requireActivitySinceLastAsk: false } });
  const asked = silent.planner.ask();
  silent.queue.recordResult(asked.taskId, { ok: true, text: '' });
  assert.equal(silent.planner.sentToday(), 0, 'NONE 不吃发送额度');
  assert.equal(silent.planner.reason(), 'asked-quota');
});

test('安静时段优先于无新素材', () => {
  const { planner, advance } = setup({ proactive: { quietFrom: 12, quietTo: 14 } });
  planner.ask(); // 10:00，不在安静时段
  advance(3 * 60 * MIN); // 13:00，间隔早就够了，素材也没有
  assert.equal(planner.reason(), 'quiet');
});

test('requireActivitySinceLastAsk: false 退回旧行为', () => {
  const { planner, advance } = setup({ proactive: { requireActivitySinceLastAsk: false } });
  planner.ask();
  advance(95 * MIN);
  assert.equal(planner.reason(), 'ok');
  assert.equal(planner.ask().asked, true);
});

test('enabled: false 时一条也不问', () => {
  const { planner, db } = setup({ proactive: { enabled: false } });
  assert.deepEqual(planner.ask(), { asked: false, reason: 'disabled', taskId: null });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 0);
});

test('hasActivitySince 只认主人的入站消息和跑完的任务', () => {
  const { queue, advance, say } = setup();
  const since = queue.now();
  assert.equal(queue.hasActivitySince(since), false);

  advance(1000);
  const group = say('群里路过一句', false);
  assert.equal(queue.hasActivitySince(since), false, '别人在群里说话不算主人有新素材');

  advance(1000);
  say('我在');
  assert.equal(queue.hasActivitySince(since), true);

  // 任务跑完这一侧不看是谁发的：她确实干了活，就有话可说。
  advance(1000);
  queue.recordResult(group.task_id, { ok: true, text: '收到' });
  assert.equal(queue.hasActivitySince(group.received_at), true);
});

test('countProactiveAsks 数的是询问，不是发出去的条数', () => {
  const { queue, planner, advance } = setup({ proactive: { minGapMs: MIN } });
  advance(1000);
  const asked = queue.insertTask({
    kind: 'private',
    userId: OWNER,
    nickname: '',
    text: '',
    images: [],
    isOwner: true,
    replyTarget: { kind: 'private', userId: OWNER },
    proactive: true,
  });
  queue.recordResult(asked.task_id, { ok: true, text: '' }); // 回了 NONE
  assert.equal(queue.countProactiveAsks(startOfDay(queue.now())), 1);
  assert.equal(planner.sentToday(), 0);
});
