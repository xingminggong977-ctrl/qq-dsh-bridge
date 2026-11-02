import path from 'node:path';

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '*', '0:0:0:0:0:0:0:0']);

/** mention: group chatter without an @bot is dropped. all: it is queued as context, needsReply=false. */
export const GROUP_MODES = Object.freeze(['mention', 'all']);

function readString(env, key, fallback) {
  const raw = env[key];
  if (raw === undefined || raw === null) return fallback;
  const value = String(raw).trim();
  return value === '' ? fallback : value;
}

/** 目录列表（QQ_FILE_ROOTS）。分隔符跟平台走，相对路径一律不要：这条路要按前缀判断能不能发。 */
function parsePathList(raw) {
  return String(raw ?? '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '' && path.isAbsolute(entry));
}

function readInt(env, key, fallback, { min, max }) {
  const raw = readString(env, key, null);
  if (raw === null) return fallback;
  if (!/^-?\d+$/.test(raw)) throw new ConfigError(`${key} must be an integer, got "${raw}"`);
  const value = Number(raw);
  if (value < min || value > max) throw new ConfigError(`${key} must be within ${min}..${max}, got ${value}`);
  return value;
}

/** 小数参数（语速、音高这类倍率）。整数字面也接受：TTS_SPEECH_RATE=1 是合法的。 */
function readNumber(env, key, fallback, { min, max }) {
  const raw = readString(env, key, null);
  if (raw === null) return fallback;
  if (!/^-?\d+(?:\.\d+)?$/.test(raw)) throw new ConfigError(`${key} must be a number, got "${raw}"`);
  const value = Number(raw);
  if (value < min || value > max) throw new ConfigError(`${key} must be within ${min}..${max}, got ${value}`);
  return value;
}

export function normalizeHost(host) {
  return String(host).trim().replace(/^\[/, '').replace(/\]$/, '');
}

/** OWNER_QQ accepts one QQ number or a comma/space separated list. */
export function parseOwnerList(raw) {
  return String(raw ?? '')
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter((part) => /^\d+$/.test(part));
}

export function loadConfig(env = process.env) {
  const bridgeHost = normalizeHost(readString(env, 'BRIDGE_HOST', '127.0.0.1'));
  // Hard requirement: the bridge is reachable only through the local SSH tunnel.
  if (bridgeHost === '' || WILDCARD_HOSTS.has(bridgeHost)) {
    throw new ConfigError(
      `BRIDGE_HOST="${readString(env, 'BRIDGE_HOST', '')}" rejected: bind a loopback address (127.0.0.1) and reach the bridge through the SSH port forward; wildcard addresses such as 0.0.0.0 are forbidden.`,
    );
  }

  const napcatWsUrl = readString(env, 'NAPCAT_WS_URL', 'ws://127.0.0.1:3001');
  if (!/^wss?:\/\/\S+$/i.test(napcatWsUrl)) {
    throw new ConfigError('NAPCAT_WS_URL must be a ws:// or wss:// URL (NapCat runs the WebSocket server, the bridge is the client)');
  }

  const nodeToken = readString(env, 'NODE_TOKEN', '');
  if (nodeToken === '') {
    throw new ConfigError('NODE_TOKEN is required: every /node/* and /blob/* request is authenticated with it');
  }

  const groupMode = readString(env, 'GROUP_MODE', 'mention');
  if (!GROUP_MODES.includes(groupMode)) {
    throw new ConfigError(`GROUP_MODE must be one of ${GROUP_MODES.join('|')}, got "${groupMode}"`);
  }

  return {
    napcatWsUrl,
    napcatAccessToken: readString(env, 'NAPCAT_ACCESS_TOKEN', ''),
    bridgeHost,
    // Port 0 means "pick an ephemeral port"; production always sets 8787.
    bridgePort: readInt(env, 'BRIDGE_PORT', 8787, { min: 0, max: 65535 }),
    nodeToken,
    ownerQq: parseOwnerList(readString(env, 'OWNER_QQ', '')),
    backlogTtlMs: readInt(env, 'BACKLOG_TTL_MS', 1800000, { min: 1000, max: 30 * 24 * 3600 * 1000 }),
    // 入站静默：WebSocket 连着却不来任何帧超过这么久，就给主人发一句话。NapCat 每
    // 30 秒推一次心跳，所以这个阈值留了十倍余量，正常聊天绝不会误报。
    inboundSilentMs: readInt(env, 'INBOUND_SILENT_MS', 180000, { min: 60000, max: 24 * 3600 * 1000 }),
    dbPath: readString(env, 'DB_PATH', '/var/lib/dsh-qq-bridge/queue.db'),
    blobDir: readString(env, 'BLOB_DIR', '/var/lib/dsh-qq-bridge/blobs'),
    // /node/send_file 能把服务器上的文件发到 QQ，所以只肯打开这几个目录：她要发的是她自己
    // 做好的东西（工作区里的产物），不该顺手把 /etc/shadow 发出去。
    //
    // 默认不再带 /tmp：线上单元开了 PrivateTmp=yes，服务眼里的 /tmp 是它自己的私有目录，
    // 2026-11-02 用 /tmp 里的图自检就得到 404 file not found（文件明明在宿主 /tmp 里）。
    // 需要临时目录就把 QQ_FILE_ROOTS 显式加上，并记得那台机器上 PrivateTmp 得是关的。
    fileRoots: parsePathList(readString(env, 'QQ_FILE_ROOTS', '/var/lib/dsh-qq-agent/workspace')),
    groupMode,
    // Voice notes arrive as SILK, which nothing here can decode; NapCat's
    // get_record hands back mp3 and this venv turns that into text. An empty
    // ASR_PYTHON disables the whole path: records degrade to a bare [语音] marker.
    asrPython: readString(env, 'ASR_PYTHON', ''),
    asrScript: readString(env, 'ASR_SCRIPT', ''),
    asrModelDir: readString(env, 'ASR_MODEL_DIR', '/opt/asr-models'),
    asrTimeoutMs: readInt(env, 'ASR_TIMEOUT_MS', 30000, { min: 5000, max: 300000 }),
    // 云端转写：三个都给了才启用，走 OpenAI 兼容的 /v1/audio/transcriptions。
    // 本地引擎保留不动，云端失败时自动退回去当兜底。
    asrUrl: readString(env, 'ASR_URL', ''),
    asrApiKey: readString(env, 'ASR_API_KEY', ''),
    asrModel: readString(env, 'ASR_MODEL', ''),
    asrLanguage: readString(env, 'ASR_LANGUAGE', 'zh'),
    asrRemoteTimeoutMs: readInt(env, 'ASR_REMOTE_TIMEOUT_MS', 15000, { min: 3000, max: 120000 }),
  // 百炼 paraformer 走异步任务链路（取凭证→上传→提交→轮询），与上面那组 OpenAI 兼容
  // 的同步接口不通用，所以 key 也不复用：两地 API Key 互斥，混用只会一路 401。
  asrDashscopeKey: readString(env, 'ASR_DASHSCOPE_KEY', ''),
  asrDashscopeModel: readString(env, 'ASR_DASHSCOPE_MODEL', 'paraformer-v2'),
  asrDashscopeRegion: readString(env, 'ASR_DASHSCOPE_REGION', 'beijing'),
  asrDashscopeTimeoutMs: readInt(env, 'ASR_DASHSCOPE_TIMEOUT_MS', 20000, { min: 5000, max: 120000 }),
    // 视频：抽几帧给她看 + 把音轨转成文字。没有开关，因为拆开之后走的
    // 就是图片和语音这两条已经能用的路；ffmpeg 找不到时自然退化成只有 [视频] 标记。
    ffmpegPath: readString(env, 'FFMPEG_PATH', '/usr/bin/ffmpeg'),
    videoFrames: readInt(env, 'VIDEO_FRAMES', 4, { min: 1, max: 12 }),
    videoTimeoutMs: readInt(env, 'VIDEO_TIMEOUT_MS', 60000, { min: 5000, max: 300000 }),
    videoWorkDir: readString(env, 'VIDEO_WORK_DIR', '/var/lib/dsh-qq-bridge'),
    // 语音回复：只对主人的私聊、只对短回复。TTS_ENABLED=off 一次全关；
    // TTS_PYTHON 空着也等于关——说不出声的时候就老实打字。
    tts: {
      enabled: readString(env, 'TTS_ENABLED', 'off') !== 'off',
      python: readString(env, 'TTS_PYTHON', ''),
      script: readString(env, 'TTS_SCRIPT', ''),
      // 两条合成路线：edge = 本地免费但音色是固定的那几个；dashscope = 百炼 CosyVoice，
      // 声音复刻出来的音色走这条。复刻音色要 key，所以 provider=dashscope 而 key 为空时
      // 整条语音链路自动退化成本地 edge——说不出声最多是打字，不能是断消息。
      provider: readString(env, 'TTS_PROVIDER', 'edge'),
      apiKey: readString(env, 'TTS_DASHSCOPE_KEY', '') || readString(env, 'ASR_DASHSCOPE_KEY', ''),
      model: readString(env, 'TTS_MODEL', 'cosyvoice-v2'),
      voice: readString(env, 'TTS_VOICE', 'zh-CN-XiaoxiaoNeural'),
      rate: readString(env, 'TTS_RATE', '+8%'),
      pitch: readString(env, 'TTS_PITCH', '+0Hz'),
      // CosyVoice 的语速/音高是 0.5~2.0 的倍率，不是 edge 那种 +8% / +0Hz 字符串。
      speechRate: readNumber(env, 'TTS_SPEECH_RATE', 1.0, { min: 0.5, max: 2 }),
      pitchRate: readNumber(env, 'TTS_PITCH_RATE', 1.0, { min: 0.5, max: 2 }),
      // 风格指令：只有 v3 / v3.5 系列认它（「像跟熟人聊天，别念稿」这种）；空＝不加。
      instruction: readString(env, 'TTS_INSTRUCTION', ''),
      maxChars: readInt(env, 'TTS_MAX_CHARS', 60, { min: 1, max: 500 }),
      dailyMax: readInt(env, 'TTS_DAILY_MAX', 20, { min: 0, max: 500 }),
      outDir: readString(env, 'TTS_OUT_DIR', '/var/lib/dsh-qq-bridge/tts'),
      timeoutMs: readInt(env, 'TTS_TIMEOUT_MS', 20000, { min: 5000, max: 120000 }),
    },
    // 主动开口。默认开着，但闸门都很硬：一天最多发出 30 条、最多问 8 次，
    // 两次询问至少隔 90 分钟，23 点到次日 8 点不敲门，且上次问过之后没有新素材就不问。
    // PROACTIVE_ENABLED=off 一次全关；PROACTIVE_REQUIRE_ACTIVITY=off 退回旧的「没事也问」。
    proactive: {
      enabled: readString(env, 'PROACTIVE_ENABLED', 'on') !== 'off',
      maxPerDay: readInt(env, 'PROACTIVE_MAX_PER_DAY', 30, { min: 0, max: 200 }),
      maxAsksPerDay: readInt(env, 'PROACTIVE_MAX_ASKS_PER_DAY', 8, { min: 0, max: 200 }),
      minGapMs: readInt(env, 'PROACTIVE_MIN_GAP_MS', 90 * 60 * 1000, { min: 60000, max: 6 * 3600 * 1000 }),
      requireActivitySinceLastAsk: readString(env, 'PROACTIVE_REQUIRE_ACTIVITY', 'on') !== 'off',
      spreadOverDay: readString(env, 'PROACTIVE_SPREAD_OVER_DAY', 'on') !== 'off',
      quietFrom: readInt(env, 'PROACTIVE_QUIET_FROM', 23, { min: 0, max: 23 }),
      quietTo: readInt(env, 'PROACTIVE_QUIET_TO', 8, { min: 0, max: 23 }),
      tickMs: readInt(env, 'PROACTIVE_TICK_MS', 60 * 1000, { min: 5000, max: 3600 * 1000 }),
    },
    // 世界生活线（whale-craft 的 life-feed.jsonl）：只给主动开口提供「由头」，
    // 不自己开口——静默时段、每日发送/询问上限仍然走上面那组 proactive 闸门。
    // WORLD_LIFE_MAX_PER_DAY 是它单独的一层上限：一天一两条特别的事就够了，
    // 不然主人会收到一份施工简报。WORLD_LIFE_ENABLED=off 一次全关。
    worldLife: {
      enabled: readString(env, 'WORLD_LIFE_ENABLED', 'on') !== 'off',
      maxPerDay: readInt(env, 'WORLD_LIFE_MAX_PER_DAY', 2, { min: 0, max: 100 }),
      windowHours: readInt(env, 'WORLD_LIFE_WINDOW_HOURS', 6, { min: 1, max: 24 * 7 }),
      file: readString(env, 'WORLD_LIFE_FILE', '/opt/whale-craft/life-feed.jsonl'),
      state: readString(env, 'WORLD_LIFE_STATE', '/var/lib/dsh-qq-bridge/world-life.json'),
    },
    // PC 工具通道的中继（docs/pc-bridge-protocol.md）。队列纯内存：桥一重启，
    // 在途命令就断在半路，这是契约里写明的取舍——命令本来就是短命的。
    pc: {
      maxInflight: readInt(env, 'PC_MAX_INFLIGHT', 4, { min: 1, max: 64 }),
      maxQueued: readInt(env, 'PC_MAX_QUEUED', 16, { min: 1, max: 256 }),
      maxBodyBytes: readInt(env, 'PC_MAX_BODY_BYTES', 1536 * 1024, { min: 1024, max: 8 * 1024 * 1024 }),
      truncateBytes: readInt(env, 'PC_TRUNCATE_BYTES', 64 * 1024, { min: 1024, max: 1024 * 1024 }),
      deadlineGraceMs: readInt(env, 'PC_DEADLINE_GRACE_MS', 5000, { min: 0, max: 60000 }),
    },
  };
}
