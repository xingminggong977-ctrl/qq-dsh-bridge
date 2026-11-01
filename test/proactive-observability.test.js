import assert from 'node:assert/strict';
import test from 'node:test';
import { openDb } from '../src/db.js';
import { createProactivePlanner, createReasonWatcher } from '../src/proactive.js';
import { Queue } from '../src/queue.js';

const OWNER = '10001';
const MIN = 60 * 1000;

/** 固定时钟：2026-10-25 10:00 本地时间，不在安静时段。 */
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
  /** 一个只记 info 行的 log：用来数「这次 tick 到底打了几句」。 */
  const recorder = () => {
    const lines = [];
    return {
      lines,
      log: { info: (msg, fields) => lines.push({ msg, ...fields }), warn: () => {} },
    };
  };
  return { db, queue, planner, clock, now, advance, say, recorder, watch: (log) => createReasonWatcher({ planner, log, now }) };
}

test('只有群消息时 hasActivitySince 为假，reason() 回到 no-activity', () => {
  const { queue, planner, advance, say } = setup();
  assert.equal(planner.ask().asked, true);
  advance(95 * MIN);
  say('群里聊得挺热闹', false);
  assert.equal(queue.hasActivitySince(queue.lastProactiveAt()), false, '群消息不是跟主人说话的素材');
  assert.equal(planner.reason(), 'no-activity');
  assert.equal(planner.ask().asked, false);
});

test('群消息之后主人自己说话，才算有新素材', () => {
  const { planner, advance, say } = setup();
  planner.ask();
  advance(95 * MIN);
  say('群里聊得挺热闹', false);
  assert.equal(planner.reason(), 'no-activity');
  advance(1000);
  say('我回来了');
  assert.equal(planner.reason(), 'ok');
});

test('主人的任务跑完（result_at）算素材', () => {
  const { queue, planner, advance, say } = setup();
  const inbound = say('帮我记一下明早九点开会');
  planner.ask(); // 询问发生在入站消息之后，所以这里只剩「完成」这一个素材来源
  advance(95 * MIN);
  queue.recordResult(inbound.task_id, { ok: true, text: '记下了' });
  assert.equal(queue.hasActivitySince(queue.lastProactiveAt()), true);
  assert.equal(planner.reason(), 'ok');
});

test('别人群里的任务跑完不算素材', () => {
  const { queue, planner, advance, say } = setup();
  planner.ask();
  advance(5 * MIN);
  const group = say('帮我看看这个', false);
  advance(90 * MIN);
  queue.recordResult(group.task_id, { ok: true, text: '看过了' });
  assert.equal(queue.hasActivitySince(queue.lastProactiveAt()), false, '不针对主人的任务跑完，不是跟她说话的素材');
  assert.equal(planner.reason(), 'no-activity');
});

test('日志只在 reason 变化时出现：同一档连打三次只有一行', () => {
  const { planner, advance, recorder, watch } = setup({ proactive: { minGapMs: 10 * MIN } });
  const { lines, log } = recorder();
  const tick = watch(log);

  tick(); // 第一次 tick 是 ok：没被挡下过，不打这一行
  assert.equal(lines.length, 0);
  planner.ask();

  advance(MIN);
  tick();
  tick();
  tick(); // 同一档 gap，值没变就静默
  assert.equal(lines.length, 1);
  assert.equal(lines[0].msg, 'proactive skipped');
  assert.equal(lines[0].reason, 'gap');

  advance(90 * MIN); // 间隔够了，但之后没人说话
  tick();
  assert.equal(lines.length, 2);
  assert.equal(lines[1].reason, 'no-activity');
});

test('ok 不打 skipped 行，但从 no-activity 切回 ok 时有一行', () => {
  const { planner, advance, say, recorder, watch } = setup();
  const { lines, log } = recorder();
  const tick = watch(log);

  planner.ask();
  advance(95 * MIN);
  tick();
  assert.equal(lines.length, 1);
  assert.equal(lines[0].msg, 'proactive skipped');
  assert.equal(lines[0].reason, 'no-activity');

  say('我回来了');
  tick(); // 切回 ok：留一行对照，方便对上「什么时候又能问了」
  assert.equal(lines.length, 2);
  assert.equal(lines[1].msg, 'proactive resumed');
  assert.equal(lines[1].reason, 'ok');
  assert.equal(lines.filter((line) => line.msg === 'proactive skipped' && line.reason === 'ok').length, 0, 'ok 不打 skipped');

  tick(); // 还是 ok，不再打
  assert.equal(lines.length, 2);
});

test('describeReason 带上各闸门的关键数字，且只讲这一件事', () => {
  const gap = setup({ proactive: { minGapMs: 30 * MIN } });
  gap.planner.ask();
  gap.advance(20 * MIN);
  assert.equal(gap.planner.reason(), 'gap');
  assert.match(gap.planner.describeReason(), /距上次询问还有 10 分钟才能再问/);

  const asked = setup({ proactive: { maxAsksPerDay: 2, minGapMs: MIN, requireActivitySinceLastAsk: false } });
  asked.planner.ask();
  asked.advance(2 * MIN);
  asked.planner.ask();
  assert.equal(asked.planner.reason(), 'asked-quota');
  assert.match(asked.planner.describeReason(), /今天已问 2 \/ 上限 2/);

  const quiet = setup({ at: new Date('2026-10-25T23:40:00'), proactive: { quietFrom: 23, quietTo: 8 } });
  assert.equal(quiet.planner.reason(), 'quiet');
  assert.match(quiet.planner.describeReason(), /现在 23 点，安静时段 23:00-8:00/);

  const idle = setup();
  idle.planner.ask();
  idle.advance(95 * MIN);
  assert.equal(idle.planner.reason(), 'no-activity');
  assert.match(idle.planner.describeReason(), /距上次询问 95 分钟，之后没有新素材/);
});

test('状态不跨实例：重启后第一次 tick 就有一行', () => {
  const { planner, advance, recorder, watch } = setup();
  planner.ask();
  advance(95 * MIN);

  const first = recorder();
  assert.equal(watch(first.log)(), 'no-activity');
  assert.equal(first.lines.length, 1);

  // 同一个 planner 上换一个 watcher，等价于进程重启：记忆从零开始，所以第一次 tick 还会有一行。
  const second = recorder();
  watch(second.log)();
  assert.equal(second.lines.length, 1);

  // 而且 reason() 没有被观测逻辑改动：仍然是 8 个稳定字符串之一。
  assert.equal(planner.reason(), 'no-activity');
  assert.deepEqual(first.lines[0].detail, '距上次询问 95 分钟，之后没有新素材');
});
