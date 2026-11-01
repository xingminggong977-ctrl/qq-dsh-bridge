import { randomUUID } from 'node:crypto';

/** 一条提醒最多能挂多远的未来：再远的日程用「日记」更合适，不是这个工具的事。 */
export const REMINDER_MAX_AHEAD_MS = 30 * 24 * 60 * 60 * 1000;

/** 到点后多久还算「该发」：进程重启错过几分钟也要补发，错过太久就当没这条。 */
export const REMINDER_GRACE_MS = 30 * 60 * 1000;

const TEXT_MAX_CHARS = 200;

export class ReminderError extends Error {
  constructor(message, { code = 'failed' } = {}) {
    super(message);
    this.name = 'ReminderError';
    this.code = code;
  }
}

/**
 * 到点喊人。
 *
 * 她答应过「明天七点叫你给爸爸打电话」，但此前系统里根本没有排程这回事——
 * 一句承诺就是一个永远不会响的闹钟。这张表就是那个闹钟的实体。
 */
export function createReminderStore({ db, log = () => {}, now = () => Date.now() } = {}) {
  if (!db || typeof db.prepare !== 'function') throw new ReminderError('缺少数据库', { code: 'config' });

  db.exec(`
    CREATE TABLE IF NOT EXISTS reminders (
      reminder_id TEXT PRIMARY KEY,
      at_ms       INTEGER NOT NULL,
      text        TEXT NOT NULL,
      target      TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      fired_at    INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders (fired_at, at_ms);
  `);

  return {
    add({ at, text, target, atNow = now() }) {
      const atMs = Number(at);
      if (!Number.isFinite(atMs)) throw new ReminderError('时间看不懂', { code: 'bad-time' });
      if (atMs <= atNow + 1000) throw new ReminderError('这个时间已经过去了', { code: 'past' });
      if (atMs - atNow > REMINDER_MAX_AHEAD_MS) throw new ReminderError('太远了，我只能记一个月内的', { code: 'too-far' });
      const body = String(text ?? '').replace(/\s+/gu, ' ').trim();
      if (body === '') throw new ReminderError('要提醒什么？', { code: 'empty' });
      if (body.length > TEXT_MAX_CHARS) throw new ReminderError(`最多 ${TEXT_MAX_CHARS} 字`, { code: 'too-long' });
      if (typeof target !== 'string' || target === '') throw new ReminderError('不知道发给谁', { code: 'no-target' });

      const reminderId = randomUUID();
      db.prepare('INSERT INTO reminders (reminder_id, at_ms, text, target, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(reminderId, atMs, body, target, atNow);
      log.info('reminder scheduled', { reminderId, atMs, chars: body.length });
      return { reminderId, at: atMs, text: body };
    },

    /** 到点且没发过的那几条；超过宽限期的直接判死，免得一重启就把三天前的提醒砸过去。 */
    due(atNow = now()) {
      const rows = db
        .prepare('SELECT reminder_id, at_ms, text, target FROM reminders WHERE fired_at IS NULL AND at_ms <= ? ORDER BY at_ms')
        .all(atNow);
      const fresh = [];
      for (const row of rows) {
        if (atNow - row.at_ms > REMINDER_GRACE_MS) {
          this.markFired(row.reminder_id, { atNow });
          log.warn('reminder expired before delivery', { reminderId: row.reminder_id, lateMs: atNow - row.at_ms });
          continue;
        }
        fresh.push(row);
      }
      return fresh;
    },

    markFired(reminderId, { atNow = now() } = {}) {
      db.prepare('UPDATE reminders SET fired_at = ? WHERE reminder_id = ? AND fired_at IS NULL').run(atNow, reminderId);
    },

    pending(atNow = now()) {
      return db
        .prepare('SELECT reminder_id, at_ms, text FROM reminders WHERE fired_at IS NULL AND at_ms > ? ORDER BY at_ms')
        .all(atNow);
    },
  };
}

/**
 * 每 tickMs 看一眼表。发送失败只记日志、不重试到底：
 * 一条三小时前的计划喊人，补发出去比不发更糟。
 */
export function createReminderTicker({ store, sendText, log = () => {}, tickMs = 15_000, now = () => Date.now() } = {}) {
  let timer = null;
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    try {
      for (const row of store.due(now())) {
        try {
          await sendText(JSON.parse(row.target), row.text);
          store.markFired(row.reminder_id, { atNow: now() });
          log.info('reminder fired', { reminderId: row.reminder_id, lateMs: now() - row.at_ms });
        } catch (err) {
          store.markFired(row.reminder_id, { atNow: now() });
          log.warn('reminder send failed', { reminderId: row.reminder_id, reason: err.message });
        }
      }
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => {
        tick().catch((err) => log.warn('reminder tick failed', { reason: err.message }));
      }, tickMs);
      timer.unref?.();
      tick().catch(() => {});
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    tick,
  };
}
