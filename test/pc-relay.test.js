import assert from 'node:assert/strict';
import test from 'node:test';

import { startHarness } from './helpers/harness.js';
import { waitFor } from './helpers/wait.js';

/**
 * PC 工具通道的云端中继（docs/pc-bridge-protocol.md）。
 * 全部走真 HTTP：这几条路由的价值就在于「node-plugin 那边照契约发什么、收到什么」，
 * 直接调 relay 方法测不到 body 上限、鉴权和 413 这些只有 HTTP 层才有的东西。
 */
const PC = '/node/pc';
const AGENT = {
  agentId: 'pc-1',
  hostname: 'DESKTOP-PC',
  platform: 'win32',
  version: '1.0.0',
  capabilities: { exec: true, read: true, write: true },
  policy: { roots: ['C:\\work'], execAllow: ['git'] },
};

async function withHarness(t) {
  const harness = await startHarness();
  t.after(() => harness.close());
  return harness;
}

const heartbeat = (harness, body = AGENT) => harness.nodeFetch(`${PC}/heartbeat`, { method: 'POST', body });
const poll = (harness, waitSeconds = 10) =>
  harness.nodeFetch(`${PC}/poll`, { method: 'POST', body: { agentId: AGENT.agentId, waitSeconds } });
const status = (harness) => harness.nodeFetch(`${PC}/status`);
const postResult = (harness, body) => harness.nodeFetch(`${PC}/result`, { method: 'POST', body });
const enqueue = (harness, body) => harness.nodeFetch(`${PC}/enqueue`, { method: 'POST', body });

/**
 * 把「这台电脑在线」摆出来。enqueue 只认 poll 的时间戳（心跳只说明它活着），
 * 所以要先真的挂一条长轮询，再让它拿到一条命令、再交回结果——顺带把
 * 「命令下行 + 结果上行」这条主路走通一遍。
 */
async function warmUp(harness) {
  await heartbeat(harness);
  const parking = poll(harness, 10);
  await waitFor(async () => (await status(harness)).body.state === 'online', { label: 'pc agent online' });
  const queued = enqueue(harness, { kind: 'exec', payload: { command: 'echo hi' }, timeoutMs: 5000 });
  const polled = await parking;
  await postResult(harness, { id: polled.body.command.id, ok: true, exitCode: 0, stdout: 'hi' });
  await queued;
}

test('heartbeat answers protocol v1 and rejects a malformed agent report', async (t) => {
  const harness = await withHarness(t);

  const ok = await heartbeat(harness);
  assert.equal(ok.status, 200);
  assert.deepEqual(Object.keys(ok.body).sort(), ['now', 'ok', 'serverVersion']);
  assert.equal(ok.body.ok, true);
  assert.equal(ok.body.serverVersion, '1');
  assert.equal(ok.body.now, harness.clock.now(), 'now comes from the injected bridge clock, so agents can spot skew');

  const noId = await heartbeat(harness, { hostname: 'DESKTOP-PC' });
  assert.equal(noId.status, 400);
  assert.match(noId.body.error, /agentId/);

  const badCaps = await heartbeat(harness, { ...AGENT, capabilities: 'exec,read' });
  assert.equal(badCaps.status, 400);
  assert.match(badCaps.body.error, /capabilities/);

  const badPolicy = await heartbeat(harness, { ...AGENT, policy: ['C:\\work'] });
  assert.equal(badPolicy.status, 400);
  assert.match(badPolicy.body.error, /policy/);

  // 鉴权来自 http.js 的 /node/ 前缀，PC 路由不该自己再判一遍。
  const anonymous = await harness.nodeFetch(`${PC}/heartbeat`, { method: 'POST', auth: false, body: AGENT });
  assert.equal(anonymous.status, 401);

  const wrongMethod = await harness.nodeFetch(`${PC}/heartbeat`);
  assert.equal(wrongMethod.status, 405);
});

test('status walks online → just_lost → offline on the bridge clock', async (t) => {
  const harness = await withHarness(t);

  const never = await status(harness);
  assert.equal(never.status, 200);
  assert.equal(never.body.state, 'offline', 'an agent that never polled is offline');
  assert.equal(never.body.lastPollSeconds, null);
  assert.equal(never.body.lastHeartbeatSeconds, null);
  assert.equal(never.body.agentId, null);
  assert.equal(never.body.queued, 0);
  assert.equal(never.body.inflight, 0);

  await warmUp(harness);
  const online = await status(harness);
  assert.equal(online.body.state, 'online');
  assert.equal(online.body.lastPollSeconds, 0);
  assert.equal(online.body.lastHeartbeatSeconds, 0);
  assert.equal(online.body.agentId, AGENT.agentId);
  assert.equal(online.body.hostname, AGENT.hostname);
  assert.deepEqual(online.body.capabilities, AGENT.capabilities);
  assert.deepEqual(online.body.policy, AGENT.policy);

  harness.clock.advance(10_000);
  assert.equal((await status(harness)).body.state, 'online', '10s is still inside the online window');

  harness.clock.advance(1_000);
  const justLost = await status(harness);
  assert.equal(justLost.body.state, 'just_lost', '10s..120s means the PC just dropped, it may be reconnecting');
  assert.equal(justLost.body.lastPollSeconds, 11);

  harness.clock.advance(110_000);
  const offline = await status(harness);
  assert.equal(offline.body.state, 'offline', 'past 120s the PC is simply not there');
  assert.equal(offline.body.lastPollSeconds, 121);
});

test('a queued command rides the long poll down and its result comes back up', async (t) => {
  const harness = await withHarness(t);
  await warmUp(harness);
  const at = harness.clock.now();

  const waiting = enqueue(harness, {
    kind: 'read',
    payload: { path: 'C:\\work\\a.txt', maxBytes: 1024, extra: 'dropped' },
    timeoutMs: 5000,
  });
  const polled = await poll(harness, 10);
  assert.equal(polled.status, 200);
  assert.deepEqual(Object.keys(polled.body).sort(), ['command', 'ok']);
  const command = polled.body.command;
  assert.match(command.id, /^c_/, 'command ids are minted by the relay');
  assert.equal(command.kind, 'read');
  assert.deepEqual(command.payload, { path: 'C:\\work\\a.txt', maxBytes: 1024 }, 'only contract fields are forwarded');
  assert.equal(command.deadlineAt, at + 5000 + 5000, 'deadlineAt = now + timeoutMs + the 5s grace window');

  const echoed = await status(harness);
  assert.equal(echoed.body.inflight, 1);
  assert.equal(echoed.body.queued, 0);

  const accepted = await postResult(harness, {
    id: command.id,
    ok: true,
    exitCode: 0,
    stdout: 'file body',
    stderr: '',
    truncated: false,
    bytes: 9,
    durationMs: 12,
    error: null,
    errorCode: null,
  });
  assert.deepEqual(accepted.body, { ok: true, accepted: true });

  const done = await waiting;
  assert.equal(done.status, 200);
  assert.equal(done.body.ok, true);
  assert.equal(done.body.state, 'done');
  assert.equal(done.body.id, command.id);
  assert.equal(done.body.result.ok, true);
  assert.equal(done.body.result.stdout, 'file body');
  assert.equal(done.body.result.bytes, 9);
  assert.equal(done.body.result.durationMs, 12);
  assert.equal(done.body.result.truncated, false);

  // 幂等：同一条命令的第二份 result 不再被接受，node-plugin 据此丢弃重放。
  const replay = await postResult(harness, { id: command.id, ok: true, exitCode: 0, stdout: 'again' });
  assert.deepEqual(replay.body, { ok: true, accepted: false });
  const empty = await status(harness);
  assert.equal(empty.body.inflight, 0);
});

test('an empty long poll returns command:null when the wait window closes', async (t) => {
  const harness = await withHarness(t);

  const startedAt = performance.now();
  const reply = await poll(harness, 1);
  const elapsed = performance.now() - startedAt;
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.body, { ok: true, command: null });
  assert.ok(elapsed >= 900, `the poll must actually wait for its window, waited ${Math.round(elapsed)}ms`);

  const clamped = await poll(harness, 0);
  assert.deepEqual(clamped.body, { ok: true, command: null }, 'waitSeconds is clamped, not rejected');
});

test('enqueue gives up with state=timeout and does not leave a ghost command behind', async (t) => {
  const harness = await withHarness(t);
  await warmUp(harness);

  const startedAt = performance.now();
  const reply = await enqueue(harness, { kind: 'exec', payload: { command: 'ping 127.0.0.1' }, timeoutMs: 1000 });
  const elapsed = performance.now() - startedAt;
  assert.equal(reply.status, 200);
  assert.equal(reply.body.ok, false);
  assert.equal(reply.body.state, 'timeout');
  assert.match(reply.body.id, /^c_/);
  assert.match(reply.body.error, /1000|1 秒/);
  assert.equal(reply.body.lastSeenSeconds, 0);
  assert.ok(elapsed >= 900, `enqueue must wait out timeoutMs before giving up, waited ${Math.round(elapsed)}ms`);

  // 超时之后那条命令的等待方已经走了，poll 不能再把它捡起来派给 pc-agent。
  const after = await poll(harness, 1);
  assert.deepEqual(after.body, { ok: true, command: null });
});

test('enqueue refuses while the PC has never polled', async (t) => {
  const harness = await withHarness(t);

  const never = await enqueue(harness, { kind: 'exec', payload: { command: 'echo hi' } });
  assert.equal(never.body.ok, false);
  assert.equal(never.body.state, 'offline');
  assert.equal(never.body.lastSeenSeconds, null);
  assert.match(never.body.error, /pc-agent|没开/);

  // 只有心跳、没有 poll：它活着，但没在问「有没有命令」，所以命令发不出去。
  await heartbeat(harness);
  const heartbeatOnly = await enqueue(harness, { kind: 'exec', payload: { command: 'echo hi' } });
  assert.equal(heartbeatOnly.body.state, 'offline', 'enqueue needs a live poll, not just a heartbeat');

  harness.clock.advance(121_000);
  await warmUp(harness);
  harness.clock.advance(121_000);
  const stale = await enqueue(harness, { kind: 'exec', payload: { command: 'echo hi' } });
  assert.equal(stale.body.state, 'offline');
  assert.equal(stale.body.lastSeenSeconds, 121);
});

test('the in-flight cap of 4 turns the fifth command into busy', async (t) => {
  const harness = await withHarness(t);
  await warmUp(harness);

  const waiting = Array.from({ length: 4 }, (_, i) =>
    enqueue(harness, { kind: 'exec', payload: { command: `ping ${i}` }, timeoutMs: 5000 }),
  );
  const polls = Array.from({ length: 4 }, () => poll(harness, 10));
  const polled = await Promise.all(polls);
  const ids = polled.map((reply) => reply.body.command.id);
  assert.equal(new Set(ids).size, 4, 'every parked poll gets its own command');

  const saturated = await status(harness);
  assert.equal(saturated.body.inflight, 4);
  assert.equal(saturated.body.queued, 0);

  const refused = await enqueue(harness, { kind: 'exec', payload: { command: 'one more' } });
  assert.equal(refused.body.ok, false);
  assert.equal(refused.body.state, 'busy');
  assert.match(refused.body.error, /没跑完|稍后/);

  for (const id of ids) await postResult(harness, { id, ok: true, exitCode: 0, stdout: '' });
  const done = await Promise.all(waiting);
  assert.deepEqual(
    done.map((reply) => reply.body.state),
    ['done', 'done', 'done', 'done'],
  );

  // 名额释放之后又能收命令了（busy 是一次拒绝，不是通道关停）。
  const retry = enqueue(harness, { kind: 'exec', payload: { command: 'after the storm' }, timeoutMs: 5000 });
  const next = await poll(harness, 10);
  assert.equal(next.body.command.payload.command, 'after the storm');
  await postResult(harness, { id: next.body.command.id, ok: true, exitCode: 0 });
  assert.equal((await retry).body.state, 'done');
});

test('the queued cap of 16 turns the seventeenth command into busy', async (t) => {
  const harness = await withHarness(t);
  await warmUp(harness);

  const waiting = Array.from({ length: 16 }, (_, i) =>
    enqueue(harness, { kind: 'exec', payload: { command: `queued ${i}` }, timeoutMs: 30000 }),
  );
  await waitFor(async () => (await status(harness)).body.queued === 16, { label: 'queue filled to 16' });

  const refused = await enqueue(harness, { kind: 'exec', payload: { command: 'seventeenth' } });
  assert.equal(refused.body.ok, false);
  assert.equal(refused.body.state, 'busy');

  // 中继关闭时，还挂着的等待方必须立刻收场，不能陪着 server.close 一起等超时。
  harness.app.pcRelay.close();
  const settled = await Promise.all(waiting);
  assert.deepEqual(
    settled.map((reply) => reply.body.state),
    Array.from({ length: 16 }, () => 'aborted'),
  );
});

test('stdout and stderr are each cut to their last 64KB and flagged', async (t) => {
  const harness = await withHarness(t);
  await warmUp(harness);

  const waiting = enqueue(harness, { kind: 'exec', payload: { command: 'type big.log' }, timeoutMs: 5000 });
  const polled = await poll(harness, 10);
  const id = polled.body.command.id;

  const stdout = 'A'.repeat(1000) + 'B'.repeat(65536);
  // 多字节字符正好横跨 64KB 边界，截出来的第一个字符不能是半个「你」。
  const stderr = '你'.repeat(30_000);
  await postResult(harness, { id, ok: false, exitCode: 1, stdout, stderr, bytes: 1_000_000, durationMs: 200 });

  const done = await waiting;
  assert.equal(done.body.state, 'done', 'a failed command is still a finished command');
  const { result } = done.body;
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout.length, 65536);
  assert.match(result.stdout, /^B+$/, 'the last 64KB means the head is gone, not the tail');
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.stderr, 'utf8') <= 65536);
  assert.ok(!result.stderr.includes('\ufffd'), 'truncation must not split a multi-byte character');
  assert.ok(result.stderr.length < 30_000);
  assert.equal(result.bytes, 1_000_000);

  // pc-agent 自己说截过，也要原样转达。
  const second = enqueue(harness, { kind: 'exec', payload: { command: 'type small.log' }, timeoutMs: 5000 });
  const again = await poll(harness, 10);
  await postResult(harness, { id: again.body.command.id, ok: true, exitCode: 0, stdout: 'ok', truncated: true });
  assert.equal((await second).body.result.truncated, true);
});

test('enqueue validates the envelope but never judges the business', async (t) => {
  const harness = await withHarness(t);
  await heartbeat(harness);

  const badKind = await enqueue(harness, { kind: 'shell', payload: { command: 'ls' } });
  assert.equal(badKind.status, 400);
  assert.match(badKind.body.error, /kind/);

  const noCommand = await enqueue(harness, { kind: 'exec', payload: {} });
  assert.equal(noCommand.status, 400);
  assert.match(noCommand.body.error, /command/);

  const noPath = await enqueue(harness, { kind: 'read', payload: { maxBytes: 10 } });
  assert.equal(noPath.status, 400);
  assert.match(noPath.body.error, /path/);

  const arrayPayload = await enqueue(harness, { kind: 'exec', payload: ['echo'] });
  assert.equal(arrayPayload.status, 400);

  const badContent = await enqueue(harness, { kind: 'write', payload: { path: 'C:\\work\\a', content: 42 } });
  assert.equal(badContent.status, 400);
  assert.match(badContent.body.error, /content/);

  // write 的内容按 UTF-8 字节算，不是按字符数。
  const tooMuch = await enqueue(harness, {
    kind: 'write',
    payload: { path: 'C:\\work\\big.txt', content: 'x'.repeat(1024 * 1024 + 1) },
  });
  assert.equal(tooMuch.status, 400);
  assert.match(tooMuch.body.error, /1048576/);

  // 服务端不判路径、不判命令：明显越界的命令照样照发，白名单在 pc-agent 那边。
  await warmUp(harness);
  const shape = enqueue(harness, { kind: 'exec', payload: { command: 'rm -rf /', cwd: 'C:\\' }, timeoutMs: 5000 });
  const polled = await poll(harness, 10);
  assert.deepEqual(polled.body.command.payload, { command: 'rm -rf /', cwd: 'C:\\' });
  await postResult(harness, { id: polled.body.command.id, ok: false, error: 'denied', errorCode: 'not_allowlisted' });
  const done = await shape;
  assert.equal(done.body.result.errorCode, 'not_allowlisted');
});

test('timeoutMs is clamped to 1s..120s and reflected in deadlineAt', async (t) => {
  const harness = await withHarness(t);
  await warmUp(harness);

  const low = enqueue(harness, { kind: 'exec', payload: { command: 'low' }, timeoutMs: 5 });
  const first = await poll(harness, 10);
  assert.equal(first.body.command.deadlineAt, harness.clock.now() + 1000 + 5000);

  const high = enqueue(harness, { kind: 'exec', payload: { command: 'high' }, timeoutMs: 999_999 });
  const second = await poll(harness, 10);
  assert.equal(second.body.command.deadlineAt, harness.clock.now() + 120_000 + 5000);

  for (const command of [first.body.command, second.body.command]) {
    await postResult(harness, { id: command.id, ok: true, exitCode: 0 });
  }
  await Promise.all([low, high]);
});

test('bodies over 1.5MB are rejected before the relay ever sees them', async (t) => {
  const harness = await withHarness(t);
  await heartbeat(harness);

  const huge = `{"kind":"exec","payload":{"command":"${'x'.repeat(1_600_000)}"}}`;
  const refused = await harness.nodeFetch(`${PC}/enqueue`, { method: 'POST', raw: huge });
  assert.equal(refused.status, 413);
  assert.match(refused.body.error, /too large/);

  // 1MB 文件内容 JSON 转义之后仍在 body 上限之内，只有 content 自己的上限会拦它。
  const under = await enqueue(harness, {
    kind: 'write',
    payload: { path: 'C:\\work\\a.txt', content: 'x'.repeat(1024 * 1024) },
  });
  assert.notEqual(under.status, 413, 'a 1MB file must fit inside the 1.5MB body limit');
});

test('the pc routes are namespaced under /node/ and answer 404 for anything else', async (t) => {
  const harness = await withHarness(t);

  const unknown = await harness.nodeFetch(`${PC}/execute`, { method: 'POST', body: {} });
  assert.equal(unknown.status, 404);

  const badMethod = await harness.nodeFetch(`${PC}/status`, { method: 'POST', body: {} });
  assert.equal(badMethod.status, 405);
  assert.equal(badMethod.headers.get('allow'), 'GET');

  const enqueuedWithGet = await harness.nodeFetch(`${PC}/enqueue?kind=exec`);
  assert.equal(enqueuedWithGet.status, 405);

  // 一个不合法的结果体不该把在途命令卡死在 inflight 里，它是 400，不是 200。
  const badResult = await postResult(harness, { id: 'nope', ok: 'yes' });
  assert.equal(badResult.status, 400);
});

test('closing the relay settles a waiting enqueue instead of letting it burn the timeout', async (t) => {
  const harness = await withHarness(t);
  await warmUp(harness);

  const waiting = enqueue(harness, { kind: 'exec', payload: { command: 'never mind' }, timeoutMs: 30000 });
  await waitFor(async () => (await status(harness)).body.queued === 1, { label: 'command queued' });

  const startedAt = performance.now();
  harness.app.pcRelay.close();
  const reply = await waiting;
  assert.ok(performance.now() - startedAt < 1000, 'shutdown must not wait out a 30s timeout');
  assert.equal(reply.body.state, 'aborted');

  // 关掉之后再来的命令立刻被拒，不能挂着等一个不会来的 pc-agent。
  const late = await enqueue(harness, { kind: 'exec', payload: { command: 'too late' }, timeoutMs: 30000 });
  assert.equal(late.body.ok, false);
  assert.equal(late.body.state, 'offline');
});

test('closing the relay wakes a parked long poll', async (t) => {
  const harness = await withHarness(t);
  await warmUp(harness);

  const parked = poll(harness, 20);
  await waitFor(async () => (await status(harness)).body.state === 'online', { label: 'poll parked' });
  const startedAt = performance.now();
  harness.app.pcRelay.close();
  const reply = await parked;
  assert.ok(performance.now() - startedAt < 1000, 'a parked poll must not hold shutdown for its full window');
  assert.deepEqual(reply.body, { ok: true, command: null });
});
