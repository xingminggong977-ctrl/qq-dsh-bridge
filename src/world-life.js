import fs from 'node:fs';
import path from 'node:path';

/**
 * 世界生活线：她在 Minecraft（`/opt/whale-craft`）里做过的事，写成一行一条的 JSONL。
 *
 * 这里只回答一个问题——「最近有没有值得跟主人说一句、而且还没说过的事」。
 * 三件事决定了它必须是一把闸门而不是一个直传管道：
 * - **只挑特别的**：`notable` 不为 `true` 的一律不主动提，否则一次挖矿就会变成流水账。
 * - **只说一次**：指纹落盘（`world-life.json`），跨进程重启仍然有效。否则每次重启都会重播同一件事。
 * - **只在时间窗内**：六小时前的建造还算新鲜，三天前的死亡已经是旧闻。
 *
 * 文件是追加写的，所以「不存在」「空行」「坏 JSON」「最后一行只写了一半」都是正常状态，
 * 不是错误：读不到就当没有，绝不把一条坏行升级成一次崩溃。
 */

/**
 * 默认值。文件名和状态路径是线上（ECS）的固定位置，测试和本地都用 env 覆盖。
 * `candidates` 是一次最多挑几条：一天一两条的节奏，一条消息里堆五件事就不再是「特别的事」。
 */
export const WORLD_LIFE_DEFAULTS = Object.freeze({
  enabled: true,
  maxPerDay: 2,
  windowHours: 6,
  candidates: 5,
  file: '/opt/whale-craft/life-feed.jsonl',
  state: '/var/lib/dsh-qq-bridge/world-life.json',
  // 状态只留最近这么多条指纹：六小时窗口加一天两条的节奏，50 条够用很久，
  // 又不至于让状态文件无限长。
  stateKeep: 50,
});

/**
 * `settings` 里显式的 `undefined` 不能盖掉默认值：调用方常常只传一部分（比如只传路径）。
 * @param settings - 部分覆盖（通常是 `config.worldLife`）。
 */
export function resolveWorldLifeSettings(settings = {}) {
  const resolved = { ...WORLD_LIFE_DEFAULTS };
  for (const [key, value] of Object.entries(settings ?? {})) {
    if (value !== undefined) resolved[key] = value;
  }
  return resolved;
}

/** 去重指纹。同一条事件被追加两次，也只会说一次。 */
export function eventKey(event) {
  return `${event.ts}|${event.kind}|${event.text}`;
}

/**
 * 一行一条地解析。坏行直接丢掉，而不是让整份文件作废——
 * 追加写的文件在任意时刻都可能停在半行上，那一行必须等价于「还没有这一行」。
 * @returns 事件数组，保持文件里的先后顺序。
 */
export function parseLifeLines(text) {
  const events = [];
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let raw;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const event = normalizeEvent(raw);
    if (event !== null) events.push(event);
  }
  return events;
}

/** 一个事件的必备形：能算出时间、有正文。别的字段缺了不影响「说不说」，也就不拦。 */
function normalizeEvent(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const ts = typeof raw.ts === 'string' ? raw.ts : '';
  const at = Date.parse(ts);
  if (!Number.isFinite(at)) return null;
  const text = typeof raw.text === 'string' ? raw.text.trim() : '';
  if (text === '') return null;
  return {
    ts,
    at,
    kind: typeof raw.kind === 'string' ? raw.kind : '',
    text,
    // 严格等于 true 才算特别：契约里就是布尔，写成 "true" 或 1 的，宁可不说。
    notable: raw.notable === true,
  };
}

/** 一行的时刻，按服务器本地时区（线上是 Asia/Shanghai，和安静时段同一套钟）。 */
function clockOf(at) {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/**
 * @param settings - 见 `WORLD_LIFE_DEFAULTS`，通常是 `config.worldLife`。
 * @param options.now - 时钟（可注入，测试用固定时间）。
 * @param options.log - 只写日志：读写状态失败绝不抛，宁可这次不说，也不让主动开口整条停摆。
 * @param options.fs - 文件操作（可注入，测试用来制造写失败）。
 */
export function createWorldLifeReader({ settings = {}, now = () => Date.now(), log = {}, fs: fsImpl = fs } = {}) {
  const options = resolveWorldLifeSettings(settings);
  const windowMs = options.windowHours * 3600 * 1000;
  // 同一个故障每 60 秒 tick 都会再撞一次，值不变就只留一行：日志是给人看的，不是计数的。
  const warned = new Set();
  const warn = (message, fields) => {
    if (warned.has(message)) return;
    warned.add(message);
    log.warn?.(message, fields);
  };

  const errorText = (error) => error?.message ?? String(error);

  /** 读事件文件。读不到就是「今天世界那边什么都没说」。 */
  const readEvents = () => {
    let text;
    try {
      text = fsImpl.readFileSync(options.file, 'utf8');
    } catch (error) {
      // 文件还不存在是正常状态（那台机器还没写过、或者路径刚配上），一次 warn 足够定位配错。
      warn('world life feed unreadable', { file: options.file, code: error?.code ?? null, error: errorText(error) });
      return [];
    }
    return parseLifeLines(text);
  };

  /** 读已说过的指纹。坏状态文件等价于空状态：宁可重说一次，不能因为状态坏了就永远不说话。 */
  const readSeen = () => {
    let raw;
    try {
      raw = fsImpl.readFileSync(options.state, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') warn('world life state unreadable', { state: options.state, error: errorText(error) });
      return [];
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      warn('world life state unreadable', { state: options.state, error: errorText(error) });
      return [];
    }
    const seen = Array.isArray(parsed?.seen) ? parsed.seen : [];
    return seen.filter((key) => typeof key === 'string');
  };

  /**
   * 落盘。先写 `.tmp` 再 rename：中途断电时状态文件要么是旧的、要么是新的，
   * 不会是半截 JSON —— 半截 JSON 会被当成空状态，把说过的事重新说一遍。
   * @returns 是否写成功；失败只打日志。
   */
  const writeSeen = (seen) => {
    const payload = JSON.stringify({ seen: seen.slice(-options.stateKeep) });
    const tmp = `${options.state}.tmp`;
    try {
      fsImpl.mkdirSync(path.dirname(options.state), { recursive: true });
      fsImpl.writeFileSync(tmp, payload);
      fsImpl.renameSync(tmp, options.state);
      return true;
    } catch (error) {
      warn('world life state write failed', { state: options.state, error: errorText(error) });
      return false;
    }
  };

  /**
   * 还没说过、且在时间窗内的 notable 事件，最多 `candidates` 条，按时间从早到晚。
   * 窗口只卡下界：世界里那台机器的钟比这里快几秒是常态，未来几秒的事件不该被丢掉。
   */
  const pickFresh = (at = now()) => {
    if (options.enabled !== true) return [];
    const since = at - windowMs;
    const seen = new Set(readSeen());
    const picked = [];
    for (const event of readEvents()) {
      if (!event.notable) continue;
      if (event.at < since) continue;
      const key = eventKey(event);
      // 同一个 key 在文件里出现两次（重启后重放）也只算一条候选。
      if (seen.has(key) || picked.some((candidate) => candidate.key === key)) continue;
      picked.push({ ...event, key });
    }
    // 只要最近的几条：八条新鲜事里最旧的那三条，已经不是「特别」而是「汇报」了。
    return picked.slice(-options.candidates);
  };

  /**
   * 由头的正文：说清「这是你在世界里刚做的事」，但**不是**一份命令。
   * 只说一句就好、退出口（NONE）留给主动开口那一轮自己的提示词，两边各说一半最容易自相矛盾。
   */
  const render = (events) => {
    const lines = events.map((event) => `- ${clockOf(event.at)} ${event.text}`);
    return ['（你在世界里刚做了这些事，可以顺口跟他提一句）', ...lines].join('\n');
  };

  /** 记下这几条已经用掉了。写失败不抛：最多下次再说一遍，不能因此打断入队。 */
  const markSpoken = (events) => {
    const list = Array.isArray(events) ? events : [];
    if (list.length === 0) return false;
    const merged = new Set(readSeen());
    for (const event of list) merged.add(eventKey(event));
    return writeSeen([...merged]);
  };

  return {
    settings: options,
    enabled: options.enabled === true,
    file: options.file,
    state: options.state,
    windowMs,
    pickFresh,
    render,
    markSpoken,
    readEvents,
    readSeen,
  };
}
