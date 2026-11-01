import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createProactivePlanner } from '../src/proactive.js';
import { Queue } from '../src/queue.js';
import {
  WORLD_LIFE_DEFAULTS,
  createWorldLifeReader,
  eventKey,
  parseLifeLines,
  resolveWorldLifeSettings,
} from '../src/world-life.js';

const OWNER = '10001';
const NOW = Date.parse('2026-10-28T12:00:00.000Z');

/** 固定时钟：世界那台机器的钟和这里不可能正好对齐，时间窗测试必须钉死。 */
const hoursAgo = (hours) => new Date(NOW - hours * 3600 * 1000).toISOString();

const event = (fields = {}) => JSON.stringify({ ts: hoursAgo(1), kind: 'build', text: '盖好了一间小屋', notable: true, ...fields });

const jsonl = (...lines) => `${lines.join('\n')}\n`;

function workspace() {
  return mkdtempSync(join(tmpdir(), 'world-life-'));
}

/** 落一份 feed + 一个（可能还不存在的）状态文件路径。 */
function fixture(text, extra = {}) {
  const dir = workspace();
  const file = join(dir, 'life-feed.jsonl');
  if (text !== null) writeFileSync(file, text);
  const state = join(dir, 'state', 'world-life.json');
  const logs = [];
  const log = {
    info: (...args) => logs.push(['info', ...args]),
    warn: (message, fields) => logs.push(['warn', message, fields]),
  };
  const reader = createWorldLifeReader({ settings: { file, state, ...extra }, now: () => NOW, log });
  return { dir, file, state, reader, logs, log };
}

test('feed file missing is empty, not fatal', () => {
  const { reader, logs } = fixture(null);
  assert.deepEqual(reader.pickFresh(), []);
  assert.deepEqual(reader.readEvents(), []);
  // 一次 warn 够定位配错的路径，不必每 tick 都喊。
  assert.equal(logs.filter((entry) => entry[1] === 'world life feed unreadable').length, 1);
});

test('bad json lines, blanks and a half-written tail are skipped, the rest still parse', () => {
  const good = event({ ts: hoursAgo(1), text: '盖好了慢屋' });
  const text = ['', 'not json at all', good, '{"ts":"2026-10-28T11:00:00.000Z",', '{"ts":"oops","text":"时间坏"}', ''].join('\n');
  const events = parseLifeLines(text);
  assert.equal(events.length, 1);
  assert.equal(events[0].text, '盖好了慢屋');
  // 半行本身不能变成一条候选（它连正文都还不存在）。
  const { reader } = fixture(text);
  assert.deepEqual(reader.pickFresh().map((item) => item.text), ['盖好了慢屋']);
});

test('non-notable events are never offered as a cue', () => {
  const { reader } = fixture(
    jsonl(
      event({ ts: hoursAgo(1), kind: 'thought', text: '今天风有点大', notable: false }),
      event({ ts: hoursAgo(2), kind: 'explore', text: '走进了一片桦树林' }),
      // 契约里 notable 是布尔，写成字符串的宁可不说。
      JSON.stringify({ ts: hoursAgo(3), kind: 'build', text: '挖了个坑', notable: 'true' }),
    ),
  );
  assert.deepEqual(reader.pickFresh().map((item) => item.text), ['走进了一片桦树林']);
});

test('events outside the window are filtered, and the window follows the setting', () => {
  const text = jsonl(
    event({ ts: hoursAgo(1), text: '一小时前的' }),
    event({ ts: hoursAgo(5), text: '五小时前的' }),
    event({ ts: hoursAgo(9), text: '九小时前的' }),
  );
  const { reader } = fixture(text);
  assert.deepEqual(reader.pickFresh().map((item) => item.text), ['一小时前的', '五小时前的']);
  const wide = fixture(text, { windowHours: 12 });
  assert.deepEqual(wide.reader.pickFresh().map((item) => item.text), ['一小时前的', '五小时前的', '九小时前的']);
});

test('at most five candidates, oldest dropped first', () => {
  const lines = [];
  for (let index = 1; index <= 7; index += 1) {
    lines.push(event({ ts: hoursAgo(index / 2), text: `第 ${index} 件事` }));
  }
  const { reader } = fixture(jsonl(...lines));
  const picked = reader.pickFresh();
  assert.equal(picked.length, 5);
  assert.deepEqual(picked.map((item) => item.text), ['第 3 件事', '第 4 件事', '第 5 件事', '第 6 件事', '第 7 件事']);
});

test('a new process does not repeat what the previous one already said', () => {
  const text = jsonl(event({ ts: hoursAgo(1), text: '盖好了慢屋' }));
  const first = fixture(text);
  const picked = first.reader.pickFresh();
  assert.equal(picked.length, 1);
  assert.equal(first.reader.markSpoken(picked), true);
  // 跨重启：新实例、同一份状态文件，靠 ts|kind|text 指纹认出来。
  const second = createWorldLifeReader({
    settings: { file: first.file, state: first.state },
    now: () => NOW,
    log: { info() {}, warn() {} },
  });
  assert.deepEqual(second.pickFresh(), []);
  assert.equal(eventKey({ ts: picked[0].ts, kind: picked[0].kind, text: picked[0].text }), picked[0].key);
});

test('state file write failure logs instead of throwing', () => {
  const { file, state } = fixture(jsonl(event()));
  const logs = [];
  const failingFs = {
    readFileSync: (...args) => readFileSync(...args),
    mkdirSync: () => {
      throw Object.assign(new Error('EACCES: permission denied, mkdir'), { code: 'EACCES' });
    },
    writeFileSync: () => {},
    renameSync: () => {},
  };
  const reader = createWorldLifeReader({
    settings: { file, state },
    now: () => NOW,
    log: { info() {}, warn: (message, fields) => logs.push([message, fields]) },
  });
  const broken = createWorldLifeReader({
    settings: { file, state },
    now: () => NOW,
    log: { info() {}, warn: (message) => logs.push([message]) },
    fs: failingFs,
  });
  assert.equal(reader.pickFresh().length, 1);
  assert.equal(broken.markSpoken(reader.pickFresh()), false);
  assert.ok(logs.some(([message]) => message === 'world life state write failed'));
  // 写不了状态也不能把入队搞挂：下一次仍然只是「可能重说一次」。
  assert.equal(broken.pickFresh().length, 1);
});

test('WORLD_LIFE_FILE / WORLD_LIFE_STATE override the defaults', () => {
  const dir = workspace();
  const file = join(dir, 'feed.jsonl');
  const state = join(dir, 'state.json');
  const config = loadConfig({ QQ_OWNER: OWNER, NODE_TOKEN: 'test-token', WORLD_LIFE_FILE: file, WORLD_LIFE_STATE: state });
  assert.equal(config.worldLife.file, file);
  assert.equal(config.worldLife.state, state);
  assert.equal(config.worldLife.enabled, true);
  assert.equal(config.worldLife.maxPerDay, 2);
  assert.equal(config.worldLife.windowHours, 6);
  const off = loadConfig({ QQ_OWNER: OWNER, NODE_TOKEN: 'test-token', WORLD_LIFE_ENABLED: 'off', WORLD_LIFE_MAX_PER_DAY: '1' });
  assert.equal(off.worldLife.enabled, false);
  assert.equal(off.worldLife.maxPerDay, 1);
  // 默认路径就是契约里那两条，改动等于和 whale-craft 脱钩。
  assert.equal(resolveWorldLifeSettings({}).file, WORLD_LIFE_DEFAULTS.file);
  assert.equal(resolveWorldLifeSettings({}).state, WORLD_LIFE_DEFAULTS.state);
});

/** `createProactivePlanner` 的一整套最小装配：闸门全开，只为看清由头怎么走。 */
function plannerFor(reader, extra = {}) {
  const db = openDb(':memory:');
  const now = () => NOW;
  const queue = new Queue({ db, backlogTtlMs: 60000, now });
  const planner = createProactivePlanner({
    config: {
      ownerQq: [OWNER],
      proactive: {
        quietFrom: 0,
        quietTo: 0,
        minGapMs: 0,
        requireActivitySinceLastAsk: false,
        maxPerDay: 9,
        maxAsksPerDay: 9,
        ...extra,
      },
    },
    queue,
    now,
    log: { info() {}, warn() {} },
    worldLife: reader,
  });
  return { db, queue, planner, reader };
}

test('proactive ask carries the fresh event as a cue, text stays empty', () => {
  const { reader } = fixture(jsonl(event({ ts: hoursAgo(1), kind: 'build', text: '盖好了 7x7x4 的慢屋，坐标 (-185,67,73)' })));
  const { planner, queue } = plannerFor(reader);
  assert.equal(planner.reason(), 'ok');
  const result = planner.ask();
  assert.equal(result.asked, true);
  const row = queue.getTask(result.taskId);
  assert.equal(row.text, '');
  assert.equal(row.proactive, true);
  assert.match(row.proactiveCue, /盖好了 7x7x4 的慢屋/);
  assert.match(row.proactiveCue, /你在世界里刚做了这些事/);
  // 说过就落盘：同一件事不会变成第二次开口。
  assert.deepEqual(reader.pickFresh(), []);
});

test('with no fresh event the old path is untouched (no cue field at all)', () => {
  const { reader } = fixture(jsonl(event({ ts: hoursAgo(30), text: '很早以前的事' })));
  const { planner, queue } = plannerFor(reader);
  const result = planner.ask();
  assert.equal(result.asked, true);
  const row = queue.getTask(result.taskId);
  assert.equal(row.text, '');
  assert.equal(row.proactive, true);
  assert.equal(row.proactiveCue ?? '', '');
  // 没有读取器时也一样：老行为不依赖 world-life 存在。
  const bare = plannerFor(null);
  const bareResult = bare.planner.ask();
  assert.equal(bareResult.asked, true);
  assert.equal(bare.queue.getTask(bareResult.taskId).proactiveCue ?? '', '');
});

test('WORLD_LIFE_MAX_PER_DAY caps cues per day while proactive itself keeps working', () => {
  const { reader } = fixture(jsonl(event({ ts: hoursAgo(1), text: '第一件' }), event({ ts: hoursAgo(2), text: '第二件' })), {
    maxPerDay: 1,
  });
  const { planner, queue } = plannerFor(reader);
  const first = planner.ask();
  assert.match(queue.getTask(first.taskId).proactiveCue, /第一件|第二件/);
  // 上限只有 1：第二次仍然可以开口，但不再带由头。
  const second = planner.ask();
  assert.equal(second.asked, true);
  assert.equal(queue.getTask(second.taskId).proactiveCue ?? '', '');
  assert.equal(queue.countWorldLifeCues(0), 1);
});

/** 一条「上一轮已经问过」的痕迹：proactive 行不算素材，只提供 lastProactiveAt()。 */
function priorAsk(queue) {
  return queue.insertTask({
    kind: 'private',
    userId: OWNER,
    nickname: '',
    text: '',
    images: [],
    isOwner: true,
    replyTarget: { kind: 'private', userId: OWNER },
    proactive: true,
  });
}

test('主人一声不吭时，世界里的新鲜事自己就能让闸门放行', () => {
  const { reader } = fixture(jsonl(event({ ts: hoursAgo(1), kind: 'death', text: '第一次被苦力怕炸死' })));
  const { planner, queue } = plannerFor(reader, { requireActivitySinceLastAsk: true });
  priorAsk(queue);
  // 缺陷里那一幕的前提：上一轮之后主人一句话没有，tasks 表里没有任何素材。
  assert.equal(queue.hasActivitySince(queue.lastProactiveAt()), false);
  assert.equal(planner.reason(), 'ok');
  // 判定反复调用不吃掉事件：落盘只属于真的入队那一次。
  assert.equal(reader.pickFresh().length, 1);
  const result = planner.ask();
  assert.equal(result.asked, true);
  const row = queue.getTask(result.taskId);
  assert.equal(row.text, '');
  assert.equal(row.proactive, true);
  assert.match(row.proactiveCue, /第一次被苦力怕炸死/);
});

test('没有世界由头时闸门照旧 no-activity，不会退化成永远放行', () => {
  const text = jsonl(event({ ts: hoursAgo(1), kind: 'death', text: '第一次被苦力怕炸死' }));
  const blanks = [
    ['worldLife=null', null],
    ['enabled=false', fixture(text, { enabled: false }).reader],
    ['feed 缺失', fixture(null).reader],
  ];
  for (const [label, worldLife] of blanks) {
    const { planner, queue } = plannerFor(worldLife, { requireActivitySinceLastAsk: true });
    priorAsk(queue);
    assert.equal(planner.reason(), 'no-activity', label);
    assert.equal(planner.describeReason(), '距上次询问 0 分钟，之后没有新素材', label);
    assert.deepEqual(planner.ask(), { asked: false, reason: 'no-activity', taskId: null }, label);
    // 只有那条「上一轮问过」的行：ask() 一条都没入队。
    assert.equal(queue.countProactiveAsks(0), 1, label);
  }
});

test('quiet hours and daily caps still win over a fresh event', () => {
  const { reader } = fixture(jsonl(event({ ts: hoursAgo(1), text: '盖好了慢屋' })));
  const quiet = plannerFor(reader, { quietFrom: 0, quietTo: 24 }).planner;
  assert.equal(quiet.reason(), 'quiet');
  const denied = quiet.ask();
  assert.equal(denied.asked, false);
  assert.equal(denied.reason, 'quiet');
  // 没开口就不算说过：等安静时段过去，这件事还在。
  assert.equal(reader.pickFresh().length, 1);

  const capped = plannerFor(reader, { maxAsksPerDay: 1 }).planner;
  assert.equal(capped.ask().asked, true);
  assert.equal(capped.reason(), 'asked-quota');
  assert.equal(capped.ask().asked, false);
});
