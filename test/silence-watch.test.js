import test from 'node:test';
import assert from 'node:assert/strict';
import { createSilenceWatch, SILENT_TEXT, DEFAULT_SILENT_MS } from '../src/watchdog.js';

const recorder = () => {
  const lines = [];
  return {
    lines,
    warn: (msg, meta) => lines.push({ level: 'warn', msg, meta }),
    info: (msg, meta) => lines.push({ level: 'info', msg, meta }),
    of: (msg) => lines.filter((line) => line.msg === msg),
  };
};

const client = (at) => ({ connected: true, lastFrameAt: at });

test('silence watch — a quiet pipe is reported once, and only after the threshold', async () => {
  const logs = recorder();
  const sent = [];
  let nowMs = 1_000_000;
  const watch = createSilenceWatch({
    client: client(nowMs),
    sendText: async (target, text) => sent.push({ target, text }),
    target: '{"kind":"private","userId":"10001"}',
    log: logs,
    now: () => nowMs,
    silentMs: 60_000,
  });

  nowMs += 30_000;
  await watch.tick();
  assert.equal(watch.alerted, false);
  assert.equal(sent.length, 0);

  nowMs += 40_000; // 70 s of silence
  await watch.tick();
  assert.equal(watch.alerted, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, SILENT_TEXT);
  assert.equal(sent[0].target, '{"kind":"private","userId":"10001"}');
  assert.equal(logs.of('napcat inbound silent').length, 1);
  assert.equal(logs.of('inbound silence alerted').length, 1);

  // 还是静默：不再重复喊。
  nowMs += 120_000;
  await watch.tick();
  assert.equal(sent.length, 1);

  // 来了一帧：复位；再超时是新一轮。
  const live = client(nowMs);
  const watch2 = createSilenceWatch({
    client: live,
    sendText: async (target, text) => sent.push({ target, text }),
    target: 't',
    log: logs,
    now: () => nowMs,
    silentMs: 60_000,
  });
  nowMs += 120_000;
  await watch2.tick();
  assert.equal(watch2.alerted, true);
  live.lastFrameAt = nowMs;
  await watch2.tick();
  assert.equal(watch2.alerted, false);
  assert.equal(logs.of('napcat inbound resumed').length, 1);
});

test('silence watch — a disconnected socket is left to the reconnect path', async () => {
  const logs = recorder();
  const sent = [];
  let nowMs = 5_000_000;
  const offline = { connected: false, lastFrameAt: nowMs - 10 * 60_000 };
  const watch = createSilenceWatch({
    client: offline,
    sendText: async (target, text) => sent.push(text),
    target: 't',
    log: logs,
    now: () => nowMs,
    silentMs: 60_000,
  });
  await watch.tick();
  assert.equal(sent.length, 0);
  assert.equal(logs.of('napcat inbound silent').length, 0);

  // 连上但立刻又是旧的帧时间（重连后一帧没来）才算静默。
  offline.connected = true;
  await watch.tick();
  assert.equal(sent.length, 1);
  assert.equal(watch.alerted, true);
});

test('silence watch — no owner target means warn only, and a failing send never throws', async () => {
  const logs = recorder();
  let nowMs = 9_000_000;
  const watch = createSilenceWatch({
    client: client(nowMs - DEFAULT_SILENT_MS - 1),
    sendText: async () => {
      throw new Error('bridge is offline');
    },
    target: null,
    log: logs,
    now: () => nowMs,
    silentMs: DEFAULT_SILENT_MS,
  });
  await watch.tick();
  assert.equal(logs.of('napcat inbound silent').length, 1);
  assert.equal(logs.of('inbound silence alert failed').length, 0);

  const broken = createSilenceWatch({
    client: client(nowMs - DEFAULT_SILENT_MS - 1),
    sendText: async () => {
      throw new Error('bridge is offline');
    },
    target: 't',
    log: logs,
    now: () => nowMs,
    silentMs: DEFAULT_SILENT_MS,
  });
  await broken.tick();
  assert.equal(broken.alerted, true);
  assert.equal(logs.of('inbound silence alert failed').length, 1);
});
