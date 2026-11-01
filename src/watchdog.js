/**
 * 入站静默监视：WS 连着、QQ 也登录着，但一条 frame 都不来 —— 2026-10-30 那次
 * 断了十个半小时的故障就长这样，进程、端口、登录态全部正常，只是没人说话。
 *
 * NapCat 每 30 秒推一次 heartbeat（`heartInterval`），所以「连着却不来帧」是可以量的。
 * 这里只做两件事：第一次超时记一条 warn 并给主人发一句话（出站是另一条路，
 * 断了也能发出去），恢复后记一条 info 复位。真正的重连交给 OneBotClient。
 */

export const DEFAULT_SILENT_MS = 180000;
export const DEFAULT_TICK_MS = 60000;
export const SILENT_TEXT =
  '我这边好像收不到消息了——半小时一点动静都没有。你要是刚发过话没等到回音，那是管道断了，不是我不理你。';

/**
 * @param client - the OneBot client; needs `connected` and `lastFrameAt`.
 * @param sendText - `(target, text) => Promise<void>`; the outbound path.
 * @param target - the QQ target to alert, in the dispatch target shape.
 * @returns `{ start, stop, tick, alerted }`.
 */
export function createSilenceWatch({
  client,
  sendText,
  target,
  log,
  now = () => Date.now(),
  silentMs = DEFAULT_SILENT_MS,
  tickMs = DEFAULT_TICK_MS,
  text = SILENT_TEXT,
}) {
  let timer = null;
  let alerted = false;
  let stopped = false;

  const reset = (reason) => {
    if (!alerted) return;
    alerted = false;
    log?.info?.('napcat inbound resumed', { reason });
  };

  async function tick() {
    if (stopped) return;
    if (client?.connected !== true) {
      // 真断线有 reconnect 在管；这里只管「连着却不来帧」。
      reset('disconnected');
      return;
    }
    const last = Number(client.lastFrameAt ?? 0);
    const ageMs = now() - last;
    if (ageMs < silentMs) {
      reset('frame');
      return;
    }
    if (alerted) return;
    alerted = true;
    log?.warn?.('napcat inbound silent', {
      silentMs: ageMs,
      lastFrameAt: last === 0 ? null : new Date(last).toISOString(),
    });
    if (target === undefined || target === null) return;
    try {
      await sendText(target, text);
      log?.info?.('inbound silence alerted', { silentMs: ageMs });
    } catch (error) {
      log?.warn?.('inbound silence alert failed', { reason: error?.message ?? String(error) });
    }
  }

  return {
    start() {
      if (timer !== null) return;
      stopped = false;
      timer = setInterval(() => {
        tick().catch((error) =>
          log?.warn?.('inbound silence tick failed', { reason: error?.message ?? String(error) }),
        );
      }, tickMs);
      timer.unref?.();
    },
    stop() {
      stopped = true;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
    tick,
    get alerted() {
      return alerted;
    },
  };
}
