import { createBlobStore } from './blobs.js';
import { createAskInbox } from './ask.js';
import { createRemoteTranscriber, createTranscriber } from './asr.js';
import { createDashscopeTranscriber } from './asr-dashscope.js';
import { createSynthesizer, synthesizerOptions } from './tts.js';
import { createVideoSplitter } from './video.js';
import { openDb } from './db.js';
import { createDispatch } from './dispatch.js';
import { createHttpServer } from './http.js';
import { createLogger } from './log.js';
import { createNotifier } from './notifier.js';
import { createOneBotClient } from './onebot.js';
import { createPcRelay } from './pc-relay.js';
import { createProactivePlanner, createReasonWatcher } from './proactive.js';
import { createReminderStore, createReminderTicker } from './reminders.js';
import { createSilenceWatch } from './watchdog.js';
import { Queue } from './queue.js';
import { RateLimiter } from './ratelimit.js';
import { createWorldLifeReader } from './world-life.js';

export const DEFAULT_TIMING = Object.freeze({
  segmentChars: 1800,
  segmentDelayMs: 300,
  sendBackoffMs: [1000, 2000, 4000],
  pollSliceMs: 1000,
});

export function createApp({ config, log, now = () => Date.now(), timing = {}, connectOneBot = true, synthesizer: injectSynthesizer, video: injectVideo, remoteAsr = null }) {
  const logger = log ?? createLogger({ secrets: [config.nodeToken, config.napcatAccessToken], now });
  const resolvedTiming = { ...DEFAULT_TIMING, ...timing };

  const db = openDb(config.dbPath);
  const queue = new Queue({ db, backlogTtlMs: config.backlogTtlMs, now });
  const ratelimiter = new RateLimiter({ db, now });
  // 世界生活线只被主动开口读，不自己开口：没有它，proactive 就是以前那个样子。
  const worldLife = createWorldLifeReader({ settings: config.worldLife, now, log: logger });
  const proactive = createProactivePlanner({ config, queue, now, log: logger, worldLife });
  let proactiveTimer = null;
  const blobs = createBlobStore({ db, dir: config.blobDir, log: logger, now });
  const notifier = createNotifier();
  const state = { closed: false };
  // 到点喊人：她答应过的日程必须真的响，不能只是嘴上说说。
  const reminders = createReminderStore({ db, log: logger, now });

  let client = null;
  // 云端转写二选一：配了百炼 key 走 paraformer 异步链路（4 个往返，短语音 1.5–3 秒），
  // 否则退回 OpenAI 兼容的同步接口。两个都没配就只剩本地 whisper 兜底。
  const dashscopeAsr = createDashscopeTranscriber({
    apiKey: config.asrDashscopeKey,
    model: config.asrDashscopeModel,
    region: config.asrDashscopeRegion,
    timeoutMs: config.asrDashscopeTimeoutMs,
    log: logger,
  });
  const compatibleAsr = createRemoteTranscriber({
    url: config.asrUrl,
    apiKey: config.asrApiKey,
    model: config.asrModel,
    language: config.asrLanguage,
    timeoutMs: config.asrRemoteTimeoutMs,
    log: logger,
  });
  const cloudAsr = remoteAsr ?? dashscopeAsr ?? compatibleAsr;
  const transcriber = createTranscriber({
    remote: cloudAsr,
    python: config.asrPython,
    script: config.asrScript,
    modelDir: config.asrModelDir,
    timeoutMs: config.asrTimeoutMs,
    log: logger,
  });
  // 转写走哪条路是排查语音问题的第一个分叉点，所以并进启动那行日志的字段里，
  // 不另起一行——启动日志的第一行必须始终是 http listening。
  const asrRoute = dashscopeAsr
    ? `dashscope ${config.asrDashscopeModel}@${config.asrDashscopeRegion}`
    : compatibleAsr
      ? 'openai-compatible'
      : 'none';
  const synthesizer = injectSynthesizer ?? createSynthesizer({
    ...synthesizerOptions(config),
    log: logger,
    now,
  });
  // 视频没有独立的开关：它就是「图片 + 语音」，两条都能用时它自然可用。
  const video = injectVideo ?? createVideoSplitter({
    ffmpegPath: config.ffmpegPath,
    timeoutMs: config.videoTimeoutMs,
    workRoot: config.videoWorkDir,
    frames: config.videoFrames,
    log: logger,
  });
  const dispatch = createDispatch({
    config,
    queue,
    ratelimiter,
    blobs,
    notifier,
    log: logger,
    now,
    timing: resolvedTiming,
    getClient: () => client,
    transcriber,
    synthesizer,
    video,
  });

  client = createOneBotClient({
    url: config.napcatWsUrl,
    accessToken: config.napcatAccessToken,
    log: logger,
    now,
    onEvent: (event) => {
      dispatch.handleEvent(event);
    },
  });

  // 入站静默：WS 连着却不来帧时给主人发一句话。10-30 那次断十个半小时，
  // 进程、端口、登录态全正常，只有「这条路上没有消息」——那种故障看起来就跟她
  // 不搭理人一模一样，得让它自己喊一声。
  const ownerQq = Array.isArray(config.ownerQq) ? config.ownerQq[0] : undefined;
  const silenceWatch = createSilenceWatch({
    client,
    log: logger,
    now,
    silentMs: config.inboundSilentMs,
    target: ownerQq === undefined ? null : JSON.stringify({ kind: 'private', userId: ownerQq }),
    sendText: (to, text) => dispatch.sendChunk(to, text),
  });

  // PC 工具通道的中继。队列纯内存，桥一重启就清空——契约里写明的取舍。
  const pcRelay = createPcRelay({ config, log: logger, now, timing: resolvedTiming });

  // 外部网关的问答：任务照常入队等她跑，答案回 HTTP，不进 QQ 投递。
  // 图片落盘复用 blobs；语音走 QQ 语音同一条转写链（云端优先、失败退本地），
  // 于是微信端发来的图和语音到了她那儿就是普通的带图任务 + 已经转写好的文字。
  // 整条 ASR 链路没配时给 null：ask 侧据此走「没听清」的占位行，不假装听过。
  const ask = createAskInbox({
    queue,
    notifier,
    log: logger,
    blobs,
    transcriber: transcriber.enabled === true ? transcriber : null,
  });

  const server = createHttpServer({
    config,
    queue,
    blobs,
    dispatch,
    notifier,
    log: logger,
    now,
    state,
    timing: resolvedTiming,
    napcatUp: () => client.connected === true,
    pcRelay,
    ask,
    reminders,
  });

  const listen = () =>
    new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve(server.address());
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(config.bridgePort, config.bridgeHost);
    }).then((address) => {
      logger.info('http listening', { host: config.bridgeHost, port: address.port, dbPath: config.dbPath, asr: asrRoute, asrLocalFallback: config.asrPython !== '' });
      return address;
    });

  const reminderTicker = createReminderTicker({
    store: reminders,
    log: logger,
    now,
    sendText: (target, text) => dispatch.sendChunk(target, text),
  });
  reminderTicker.start();
  silenceWatch.start();

  const close = async () => {
    state.closed = true;
    reminderTicker.stop();
    silenceWatch.stop();
    if (proactiveTimer !== null) {
      clearInterval(proactiveTimer);
      proactiveTimer = null;
    }
    client.stop();
    // 先让 PC 通道收场：还在等结果的 enqueue 不能挂在 server.close 上陪跑两秒。
    pcRelay.close();
    notifier.notify();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2000);
      timer.unref?.();
      try {
        server.close(() => {
          clearTimeout(timer);
          resolve();
        });
      } catch {
        clearTimeout(timer);
        resolve();
      }
      server.closeAllConnections?.();
    });
    try {
      db.close();
    } catch {
      /* already closed */
    }
  };

  return {
    config,
    log: logger,
    db,
    queue,
    ratelimiter,
    proactive,
    blobs,
    notifier,
    dispatch,
    onebot: client,
    pcRelay,
    ask,
    http: server,
    state,
    listen,
    address: () => server.address(),
    async start() {
      const address = await listen();
      if (connectOneBot) client.start();
      // 主动开口只在真正跑起来的实例里计时；测试里 connectOneBot/start 不调用就不会有定时器。
      if (config.proactive?.enabled !== false) {
        // 闸门状态挂在这次 start 的闭包里：进程重启就是新的一份，第一次 tick 一定会有一行。
        const watchReason = createReasonWatcher({ planner: proactive, log: logger, now });
        logger.info('proactive gate armed', {
          tickMs: config.proactive?.tickMs ?? 60000,
          minGapMs: config.proactive?.minGapMs ?? null,
          maxAsksPerDay: config.proactive?.maxAsksPerDay ?? null,
          // 由头从哪来、上限几条、路径对不对，是部署后第一个要排除的怀疑对象。
          worldLife: worldLife.enabled,
          worldLifeFile: worldLife.file,
          worldLifeMaxPerDay: worldLife.settings.maxPerDay,
          reason: proactive.reason(now()),
        });
        // 开闸就先看一眼闸门，别干等第一个 tick：启动日志里立刻能读出「现在能不能问、为什么」。
        watchReason();
        proactiveTimer = setInterval(() => {
          try {
            // 先看闸门再看要不要问：ask() 自己会再判一次，这里只为把「没问」的原因记下来。
            watchReason();
            proactive.ask();
          } catch (error) {
            logger.warn('proactive tick failed', { error: error?.message ?? String(error) });
          }
        }, config.proactive?.tickMs ?? 60000);
        proactiveTimer.unref?.();
      }
      return address;
    },
    close,
  };
}
