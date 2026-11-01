export const RATE_LIMIT_PER_MINUTE = 6;
export const RATE_WINDOW_MS = 60000;
export const RATE_NOTICE_COOLDOWN_MS = 300000; // PROTOCOL: at most one hint per 5 minutes

export class RateLimiter {
  constructor({
    db,
    now = () => Date.now(),
    limit = RATE_LIMIT_PER_MINUTE,
    windowMs = RATE_WINDOW_MS,
    noticeCooldownMs = RATE_NOTICE_COOLDOWN_MS,
  }) {
    this.db = db;
    this.now = now;
    this.limit = limit;
    this.windowMs = windowMs;
    this.noticeCooldownMs = noticeCooldownMs;
  }

  /**
   * Counts one enqueue attempt for `userId`.
   * Returns { allowed, noticeAllowed, count }.
   */
  register(userId) {
    const at = this.now();
    const since = at - this.windowMs;
    this.db.prepare('DELETE FROM rate_events WHERE ts <= ?').run(since);
    const row = this.db
      .prepare('SELECT COUNT(*) AS c FROM rate_events WHERE user_id = ? AND ts > ?')
      .get(String(userId), since);
    const count = row ? Number(row.c) : 0;

    if (count >= this.limit) {
      const notice = this.db.prepare('SELECT last_at FROM rate_notices WHERE user_id = ?').get(String(userId));
      let noticeAllowed = false;
      if (!notice) {
        this.db.prepare('INSERT INTO rate_notices (user_id, last_at) VALUES (?, ?)').run(String(userId), at);
        noticeAllowed = true;
      } else if (at - Number(notice.last_at) >= this.noticeCooldownMs) {
        this.db.prepare('UPDATE rate_notices SET last_at = ? WHERE user_id = ?').run(at, String(userId));
        noticeAllowed = true;
      }
      return { allowed: false, noticeAllowed, count };
    }

    this.db.prepare('INSERT INTO rate_events (user_id, ts) VALUES (?, ?)').run(String(userId), at);
    return { allowed: true, noticeAllowed: false, count: count + 1 };
  }
}
