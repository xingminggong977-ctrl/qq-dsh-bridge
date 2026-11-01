import crypto from 'node:crypto';

import { createNotifier } from './notifier.js';

/**
 * PC 工具通道的云端中继（docs/pc-bridge-protocol.md v1）。
 *
 * 这里只搬运：云端永远不主动连电脑、也不执行任何东西。命令向下、结果向上，
 * 路径白名单与命令白名单全在 pc-agent 本地判，所以本文件除了 kind、字段类型、
 * 长度上限之外不判断任何业务——判多了就是替别人的安全边界做主。
 */
export const PC_KINDS = Object.freeze(['exec', 'read', 'write']);

export const PC_ERROR_CODES = Object.freeze([
  'not_allowlisted',
  'path_denied',
  'timeout',
  'spawn_failed',
  'too_large',
  'internal',
]);

export const PC_SERVER_VERSION = '1';

const DEFAULT_TIMEOUT_MS = 30000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 120000;
const DEFAULT_POLL_WAIT_S = 25;
const MIN_POLL_WAIT_S = 1;
const MAX_POLL_WAIT_S = 30;
// 契约表：poll 在 10s 内算在线，120s 内算刚断，再久就是没开机。
const ONLINE_WITHIN_S = 10;
const JUST_LOST_WITHIN_S = 120;
const MAX_PATH_CHARS = 4096;
const MAX_COMMAND_CHARS = 8192;
const MAX_CONTENT_BYTES = 1024 * 1024;
const MAX_AGENT_FIELD_CHARS = 255;

class PcInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PcInputError';
  }
}

/** 入参不合规：只有这一类错回 400，其余照常 500。 */
function reject(message) {
  throw new PcInputError(message);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function createPcRelay({ config, log, now = () => Date.now(), timing = {} }) {
  const limits = config.pc ?? {};
  const maxInflight = limits.maxInflight ?? 4;
  const maxQueued = limits.maxQueued ?? 16;
  const truncateBytes = limits.truncateBytes ?? 65536;
  const deadlineGraceMs = limits.deadlineGraceMs ?? 5000;
  const pollSliceMs = timing.pollSliceMs ?? 1000;

  const notifier = createNotifier();
  /** 已提交、还没被 poll 取走，最老的在前。 */
  const queued = [];
  /** 已经被交给 pc-agent、还欠一条 result。名额上限就是这里。 */
  const inflight = new Map();
  let identity = { agentId: null, hostname: null, platform: null, version: null, capabilities: null, policy: null };
  let lastHeartbeatAt = null;
  let lastPollAt = null;
  let openPolls = 0;
  let closed = false;

  /**
   * 三态只看 poll：心跳只证明电脑活着，poll 才证明它现在真能收命令——
   * enqueue 要靠这个判断该不该把命令发出去。一条正挂着的长轮询本身就是
   * 「它就在那儿」，所以它挂着的这段时间按 0 秒算；否则 pc-agent 用 25s
   * 长轮询时，状态会在 online / just_lost 之间来回跳。
   */
  function liveness() {
    const at = now();
    const pollAt = openPolls > 0 ? at : lastPollAt;
    const lastPollSeconds = pollAt === null ? null : Math.max(0, Math.floor((at - pollAt) / 1000));
    const lastHeartbeatSeconds =
      lastHeartbeatAt === null ? null : Math.max(0, Math.floor((at - lastHeartbeatAt) / 1000));
    const seenAt =
      lastPollAt === null ? lastHeartbeatAt : lastHeartbeatAt === null ? lastPollAt : Math.max(lastPollAt, lastHeartbeatAt);
    const lastSeenSeconds = seenAt === null ? null : Math.max(0, Math.floor((at - seenAt) / 1000));
    return { lastPollSeconds, lastHeartbeatSeconds, lastSeenSeconds };
  }

  function linkState(lastPollSeconds) {
    if (lastPollSeconds === null || lastPollSeconds > JUST_LOST_WITHIN_S) return 'offline';
    if (lastPollSeconds > ONLINE_WITHIN_S) return 'just_lost';
    return 'online';
  }

  /**
   * deadlineAt 过期还没回来的在途命令直接放掉，别让它一直占着那 4 个名额。
   * 只放名额、不替 pc-agent 记结果：迟到的 result 那时已经没人等，按未知 id 处理。
   */
  function sweep() {
    const at = now();
    for (const [id, record] of inflight) {
      if (record.deadlineAt > at) continue;
      inflight.delete(id);
      log.warn('pc command expired in flight', { id, kind: record.kind });
    }
  }

  /**
   * 等待方收场（拿到了 result / 超时 / 断开 / 中继关闭）。
   * 还没被取走的命令必须同时从 queued 里摘掉，否则 pc-agent 会捡到一条
   * 根本没人在等的命令，还得替它跑一遍。
   */
  function settle(record, outcome) {
    if (record.settled) return;
    record.settled = true;
    if (record.timer !== null) {
      clearTimeout(record.timer);
      record.timer = null;
    }
    const index = queued.indexOf(record);
    if (index >= 0) queued.splice(index, 1);
    record.resolve(outcome);
  }

  function takeQueued() {
    while (queued.length > 0) {
      const record = queued.shift();
      if (!record.settled) return record;
    }
    return null;
  }

  function readAgentField(value, name) {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') reject(`${name} must be a string`);
    if (value.length > MAX_AGENT_FIELD_CHARS) reject(`${name} is over the ${MAX_AGENT_FIELD_CHARS} character limit`);
    return value;
  }

  function readInteger(value, name, min, max, fallback) {
    if (value === undefined || value === null) return fallback;
    if (!Number.isInteger(value)) reject(`${name} must be an integer`);
    return Math.min(max, Math.max(min, value));
  }

  function readOptionalInteger(value, name, min, max) {
    if (value === undefined || value === null) return null;
    if (!Number.isInteger(value) || value < min || value > max) reject(`${name} must be an integer within ${min}..${max}`);
    return value;
  }

  function readPayloadPath(payload) {
    const value = payload.path;
    if (typeof value !== 'string' || value === '') reject('payload.path is required');
    if (value.length > MAX_PATH_CHARS) reject(`payload.path is over the ${MAX_PATH_CHARS} character limit`);
    return value;
  }

  /**
   * 只查 kind 对应的字段类型与长度上限，不查路径合不合法、命令危不危险。
   * 只转发契约里写明的字段，多出来的字段丢掉——不让未知字段顺着通道往下走。
   */
  function readPayload(kind, payload) {
    if (!isPlainObject(payload)) reject('payload must be a JSON object');

    if (kind === 'exec') {
      const command = payload.command;
      if (typeof command !== 'string' || command === '') reject('payload.command is required');
      if (command.length > MAX_COMMAND_CHARS) reject(`payload.command is over the ${MAX_COMMAND_CHARS} character limit`);
      const out = { command };
      if (payload.cwd !== undefined && payload.cwd !== null) {
        if (typeof payload.cwd !== 'string' || payload.cwd === '') reject('payload.cwd must be a non-empty string');
        if (payload.cwd.length > MAX_PATH_CHARS) reject(`payload.cwd is over the ${MAX_PATH_CHARS} character limit`);
        out.cwd = payload.cwd;
      }
      const timeoutMs = readOptionalInteger(payload.timeoutMs, 'payload.timeoutMs', 1, MAX_TIMEOUT_MS);
      if (timeoutMs !== null) out.timeoutMs = timeoutMs;
      return out;
    }

    if (kind === 'read') {
      const out = { path: readPayloadPath(payload) };
      const maxBytes = readOptionalInteger(payload.maxBytes, 'payload.maxBytes', 1, MAX_CONTENT_BYTES);
      if (maxBytes !== null) out.maxBytes = maxBytes;
      return out;
    }

    const out = { path: readPayloadPath(payload) };
    if (typeof payload.content !== 'string') reject('payload.content is required');
    if (Buffer.byteLength(payload.content, 'utf8') > MAX_CONTENT_BYTES) {
      reject(`payload.content is over the ${MAX_CONTENT_BYTES} byte limit`);
    }
    out.content = payload.content;
    if (payload.append !== undefined && payload.append !== null) {
      if (typeof payload.append !== 'boolean') reject('payload.append must be a boolean');
      out.append = payload.append;
    }
    return out;
  }

  /** 契约：stdout / stderr 各留最后 64KB，置 truncated。 */
  function readResultText(value, name) {
    if (value === undefined || value === null) return { text: '', truncated: false };
    if (typeof value !== 'string') reject(`${name} must be a string`);
    const bytes = Buffer.byteLength(value, 'utf8');
    if (bytes <= truncateBytes) return { text: value, truncated: false };
    const window = Buffer.from(value, 'utf8').subarray(bytes - truncateBytes);
    // 从头切在多字节字符的续字节上会让首字符变乱码，往前挪到字符边界。
    let offset = 0;
    while (offset < window.length && (window[offset] & 0xc0) === 0x80) offset += 1;
    return { text: window.subarray(offset).toString('utf8'), truncated: true };
  }

  async function heartbeatOnce(body) {
    if (typeof body.agentId !== 'string' || body.agentId.trim() === '') reject('agentId is required');
    const next = {
      agentId: body.agentId.trim(),
      hostname: readAgentField(body.hostname, 'hostname'),
      platform: readAgentField(body.platform, 'platform'),
      version: readAgentField(body.version, 'version'),
      capabilities: body.capabilities ?? null,
      policy: body.policy ?? null,
    };
    if (next.capabilities !== null && !isPlainObject(next.capabilities)) reject('capabilities must be a JSON object');
    if (next.policy !== null && !isPlainObject(next.policy)) reject('policy must be a JSON object');

    // 心跳每 10s 一次，只在身份或 policy 真的变了的时候写日志，否则一天几万行噪音。
    const announced =
      identity.agentId !== next.agentId ||
      identity.hostname !== next.hostname ||
      JSON.stringify(identity.policy) !== JSON.stringify(next.policy);
    identity = next;
    lastHeartbeatAt = now();
    if (announced) {
      log.info('pc agent announced', {
        agentId: next.agentId,
        hostname: next.hostname,
        platform: next.platform,
        version: next.version,
        roots: Array.isArray(next.policy?.roots) ? next.policy.roots.length : undefined,
      });
    }
    return { status: 200, body: { ok: true, now: lastHeartbeatAt, serverVersion: PC_SERVER_VERSION } };
  }

  async function pollOnce(body) {
    const waitSeconds = readInteger(body.waitSeconds, 'waitSeconds', MIN_POLL_WAIT_S, MAX_POLL_WAIT_S, DEFAULT_POLL_WAIT_S);
    const budgetMs = waitSeconds * 1000;
    // 等待预算走墙钟：deadlineAt 来自注入的 now，那是业务时钟，测试里会跳。
    const startedAt = performance.now();
    lastPollAt = now();
    openPolls += 1;
    try {
      for (;;) {
        if (closed) return { status: 200, body: { ok: true, command: null } };
        sweep();
        const record = takeQueued();
        if (record !== null) {
          inflight.set(record.id, record);
          lastPollAt = now();
          return {
            status: 200,
            body: {
              ok: true,
              command: { id: record.id, kind: record.kind, deadlineAt: record.deadlineAt, payload: record.payload },
            },
          };
        }
        const remaining = budgetMs - (performance.now() - startedAt);
        if (remaining <= 0) {
          lastPollAt = now();
          return { status: 200, body: { ok: true, command: null } };
        }
        // 切片等：enqueue 与关闭都要能立刻叫醒它，而不是等满 30 秒。
        await notifier.wait(Math.min(remaining, pollSliceMs));
      }
    } finally {
      openPolls -= 1;
      lastPollAt = now();
    }
  }

  async function resultOnce(body) {
    if (typeof body.id !== 'string' || body.id === '') reject('id is required');
    if (typeof body.ok !== 'boolean') reject('ok must be a boolean');
    if (body.truncated !== undefined && typeof body.truncated !== 'boolean') reject('truncated must be a boolean');
    const exitCode = readOptionalInteger(body.exitCode, 'exitCode', -2147483648, 2147483647);
    const bytes = readOptionalInteger(body.bytes, 'bytes', 0, Number.MAX_SAFE_INTEGER);
    const durationMs = readOptionalInteger(body.durationMs, 'durationMs', 0, Number.MAX_SAFE_INTEGER);
    const error = body.error === undefined ? null : body.error;
    if (error !== null && typeof error !== 'string') reject('error must be a string or null');
    const errorCode = body.errorCode === undefined ? null : body.errorCode;
    if (errorCode !== null && !PC_ERROR_CODES.includes(errorCode)) {
      reject(`errorCode must be one of ${PC_ERROR_CODES.join('|')} or null`);
    }
    const stdout = readResultText(body.stdout, 'stdout');
    const stderr = readResultText(body.stderr, 'stderr');

    const record = inflight.get(body.id);
    if (record === undefined) {
      // 幂等：同一条 command 的第二次 result（以及重启前残留的 id）都不收。
      // accepted:false 是唯一的信号，node-plugin 那边据此丢重放。
      log.warn('pc result for an unknown or already settled id', { id: body.id });
      return { status: 200, body: { ok: true, accepted: false } };
    }
    inflight.delete(body.id);
    const result = {
      id: body.id,
      ok: body.ok,
      exitCode,
      stdout: stdout.text,
      stderr: stderr.text,
      // pc-agent 说截了就截了；我们这里真截过也必须置 true，不然当事人不知道内容不全。
      truncated: body.truncated === true || stdout.truncated || stderr.truncated,
      bytes,
      durationMs,
      error,
      errorCode,
    };
    settle(record, { ok: true, id: body.id, state: 'done', result });
    log.info('pc result recorded', {
      id: body.id,
      kind: record.kind,
      ok: body.ok,
      errorCode,
      truncated: result.truncated,
      bytes,
      durationMs,
    });
    return { status: 200, body: { ok: true, accepted: true } };
  }

  async function enqueueOnce(body, { signal } = {}) {
    const kind = body.kind;
    if (typeof kind !== 'string' || !PC_KINDS.includes(kind)) reject(`kind must be one of ${PC_KINDS.join('|')}`);
    const payload = readPayload(kind, body.payload);
    const timeoutMs = readInteger(body.timeoutMs, 'timeoutMs', MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
    const id = `c_${crypto.randomUUID()}`;
    sweep();
    const live = liveness();
    const state = linkState(live.lastPollSeconds);

    // 桥在关：队列已经清了，再收下这条命令只会挂满整个 timeoutMs 然后被超时收场。
    if (closed) {
      return {
        status: 200,
        body: { ok: false, id, state: 'offline', error: 'bridge 正在关闭，命令没有发出去', lastSeenSeconds: live.lastSeenSeconds },
      };
    }

    // just_lost 也照发：契约里 10~120s 是「刚断开，可能正在重连」，命令排队等它回来
    // 就是这条通道存在的意义。只有真 offline（或者从没报到过）才根本没地方发。
    if (state === 'offline') {
      log.warn('pc enqueue refused: offline', { id, kind, lastSeenSeconds: live.lastSeenSeconds });
      return {
        status: 200,
        body: {
          ok: false,
          id,
          state: 'offline',
          error: '电脑没开着，或 pc-agent 没在跑',
          lastSeenSeconds: live.lastSeenSeconds,
        },
      };
    }
    if (inflight.size >= maxInflight || queued.length >= maxQueued) {
      log.warn('pc enqueue refused: busy', { id, kind, inflight: inflight.size, queued: queued.length });
      return {
        status: 200,
        body: {
          ok: false,
          id,
          state: 'busy',
          error: '电脑那边手上的命令还没跑完，稍后再试',
          lastSeenSeconds: live.lastSeenSeconds,
        },
      };
    }

    const enqueuedAt = now();
    const record = {
      id,
      kind,
      payload,
      enqueuedAt,
      // 契约：多给 5s 宽限，已经发出去的命令在等待方超时后还能收下迟到的 result。
      deadlineAt: enqueuedAt + Math.max(timeoutMs, 0) + deadlineGraceMs,
      settled: false,
      resolve: null,
      timer: null,
    };
    const settled = new Promise((resolve) => {
      record.resolve = resolve;
    });
    record.timer = setTimeout(() => {
      log.warn('pc command timed out', { id, kind, timeoutMs });
      settle(record, {
        ok: false,
        id,
        state: 'timeout',
        error: `电脑开着，但 ${Math.round(timeoutMs / 1000)} 秒没回话，可能正忙`,
        lastSeenSeconds: liveness().lastSeenSeconds,
      });
    }, timeoutMs);
    queued.push(record);
    notifier.notify();

    // 等待方断开（node-plugin 那边超时或客户端取消）→ 命令作废，不留垃圾。
    const onAbort = () => settle(record, { ok: false, id, state: 'aborted' });
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return { status: 200, body: await settled };
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async function statusOnce() {
    sweep();
    const live = liveness();
    return {
      status: 200,
      body: {
        ok: true,
        state: linkState(live.lastPollSeconds),
        agentId: identity.agentId,
        hostname: identity.hostname,
        lastPollSeconds: live.lastPollSeconds,
        lastHeartbeatSeconds: live.lastHeartbeatSeconds,
        capabilities: identity.capabilities,
        policy: identity.policy,
        queued: queued.length,
        inflight: inflight.size,
      },
    };
  }

  /** 把「入参不合规」翻译成 400，别的一律往上抛成 500。 */
  function guard(handler) {
    return async (...args) => {
      try {
        return await handler(...args);
      } catch (error) {
        if (error instanceof PcInputError) return { status: 400, body: { ok: false, error: error.message } };
        throw error;
      }
    };
  }

  function close() {
    closed = true;
    for (const record of [...queued, ...inflight.values()]) {
      settle(record, { ok: false, id: record.id, state: 'aborted' });
    }
    queued.length = 0;
    inflight.clear();
    // 叫醒所有挂着的长轮询，让它们在下一个切片立刻返回 command:null。
    notifier.notify();
  }

  return {
    heartbeat: guard(heartbeatOnce),
    poll: guard(pollOnce),
    result: guard(resultOnce),
    enqueue: guard(enqueueOnce),
    status: guard(statusOnce),
    close,
  };
}
