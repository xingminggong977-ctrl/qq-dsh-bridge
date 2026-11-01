import crypto from 'node:crypto';

export const STATUS = Object.freeze({
  QUEUED: 'queued',
  DELIVERING: 'delivering',
  RUNNING: 'running',
  DONE: 'done',
  FAILED: 'failed',
  EXPIRED: 'expired',
});

export const DELIVERING_LEASE_MS = 120000; // PROTOCOL: leaseUntil = now + 120000 on delivery
export const RUNNING_LEASE_MS = 600000; // PROTOCOL: accepted -> running, lease now + 600000

/** SQLite row -> wire Task. Field set and name spelling are fixed by PROTOCOL.md. */
export function rowToTask(row) {
  return {
    taskId: row.task_id,
    kind: row.kind,
    groupId: row.group_id ?? null,
    userId: row.user_id,
    nickname: row.nickname,
    text: row.text,
    images: JSON.parse(row.images),
    receivedAt: row.received_at,
    deadlineAt: row.deadline_at,
    isOwner: row.is_owner === 1,
    mentioned: row.mentioned === 1,
    needsReply: row.needs_reply === 1,
    // Optional on the wire: only a proactive task (one the bridge invented,
    // not a message the user sent) carries it, so older nodes see nothing new.
    ...(row.proactive === 1 ? { proactive: true } : {}),
    // 主动开口的由头（「你在世界里刚做了什么」）。同样只在有值时出现：
    // 旧 node 不认识这个字段，它看到的仍然是一条空 text 的 proactive 任务。
    ...(row.proactive_cue ? { proactiveCue: row.proactive_cue } : {}),
    // 只在 ask 任务上出现，且刻意说明「答案不要投递到 QQ」：让她那一侧能看见
    // 这是一次借用大脑的问答。QQ 任务不带这个字段，线上协议对老 node 一字未变。
    ...(row.origin === 'ask' ? { origin: 'ask', deliver: false } : {}),
  };
}

export class Queue {
  constructor({ db, backlogTtlMs, now = () => Date.now() }) {
    this.db = db;
    this.backlogTtlMs = backlogTtlMs;
    this.now = now;
  }

  insertTask({
    kind,
    groupId = null,
    userId,
    nickname,
    text,
    images,
    isOwner,
    replyTarget,
    mentioned = true,
    needsReply = mentioned,
    proactive = false,
    proactiveCue = '',
    origin = 'qq',
  }) {
    const at = this.now();
    const taskId = crypto.randomUUID();
    const deadlineAt = at + this.backlogTtlMs;
    this.db
      .prepare(
        `INSERT INTO tasks (task_id, kind, group_id, user_id, nickname, text, images, received_at,
           deadline_at, is_owner, mentioned, needs_reply, proactive, proactive_cue, origin, reply_target, status, lease_until, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)`,
      )
      .run(
        taskId,
        kind,
        groupId,
        String(userId),
        nickname,
        text,
        JSON.stringify(images),
        at,
        deadlineAt,
        isOwner ? 1 : 0,
        mentioned ? 1 : 0,
        needsReply ? 1 : 0,
        proactive ? 1 : 0,
        proactive ? String(proactiveCue ?? '') : '',
        origin,
        JSON.stringify(replyTarget),
        STATUS.QUEUED,
        at,
        at,
      );
    return this.getRow(taskId);
  }

  /**
   * How many proactive messages actually reached the user since `sinceMs`.
   * Counted from results, not from asks: a turn that answered NONE sent nothing
   * and must not eat the daily allowance.
   */
  countProactiveSent(sinceMs) {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM tasks
          WHERE proactive = 1 AND result_ok = 1 AND COALESCE(result_text, '') <> '' AND result_at >= ?`,
      )
      .get(sinceMs);
    return Number(row?.n ?? 0);
  }

  /** When the bridge last asked her to speak up, whether or not she did. */
  lastProactiveAt() {
    const row = this.db.prepare('SELECT MAX(created_at) AS at FROM tasks WHERE proactive = 1').get();
    return typeof row?.at === 'number' ? row.at : null;
  }

  /**
   * How many times the bridge asked her since `sinceMs`, whatever she answered.
   * Asks cost tokens even when the answer is NONE, so they get their own allowance.
   */
  countProactiveAsks(sinceMs) {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM tasks WHERE proactive = 1 AND created_at >= ?')
      .get(sinceMs);
    return Number(row?.n ?? 0);
  }

  /**
   * 今天有几次主动开口是带着「世界里的由头」的。
   * 数的是入队次数而不是发出去条数：由头一旦用掉，那件事就算说过了，
   * 再问一次也会因为指纹落盘而拿不到同一件事。
   */
  countWorldLifeCues(sinceMs) {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM tasks
          WHERE proactive = 1 AND COALESCE(proactive_cue, '') <> '' AND created_at >= ?`,
      )
      .get(sinceMs);
    return Number(row?.n ?? 0);
  }

  /**
   * 「有没有新素材」：`sinceMs` 之后主人自己说了话，或者有一条**主人的**任务真的跑完了。
   * 群消息一律不算：别人在群里聊得再热闹，主人也没跟她说过一句；把它当素材，等于把「群活跃」
   * 读成「他刚想找我」，于是一整天他一声不吭，她照样去私聊他。
   * 两侧都限定 is_owner = 1，proactive 行再排除——否则她问一次就等于给自己续一次命。
   */
  hasActivitySince(sinceMs) {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM tasks
          WHERE proactive = 0 AND is_owner = 1
            AND (received_at > ? OR (result_at IS NOT NULL AND result_at > ?))`,
      )
      .get(sinceMs, sinceMs);
    return Number(row?.n ?? 0) > 0;
  }

  getRow(taskId) {
    return this.db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId) ?? null;
  }

  getTask(taskId) {
    const row = this.getRow(taskId);
    return row ? rowToTask(row) : null;
  }

  queuedCount() {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM tasks WHERE status = ?').get(STATUS.QUEUED);
    return row ? Number(row.c) : 0;
  }

  /**
   * Dead node recovery: an expired lease puts the task back in the queue.
   * PROTOCOL only names `delivering`; `running` is included so a node that died
   * mid-turn cannot park a task forever (at-least-once, see DECISIONS D14).
   */
  reclaimExpiredLeases(at = this.now()) {
    const info = this.db
      .prepare(
        `UPDATE tasks SET status = ?, lease_until = 0, updated_at = ?
         WHERE status IN (?, ?) AND lease_until > 0 AND lease_until < ?`,
      )
      .run(STATUS.QUEUED, at, STATUS.DELIVERING, STATUS.RUNNING, at);
    return Number(info.changes);
  }

  /** queued tasks past their deadline are expired and never delivered; returns those rows. */
  expireOverdue(at = this.now()) {
    const rows = this.db
      .prepare('SELECT * FROM tasks WHERE status = ? AND deadline_at < ? ORDER BY received_at ASC, rowid ASC')
      .all(STATUS.QUEUED, at);
    if (rows.length === 0) return [];
    const update = this.db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE task_id = ? AND status = ?');
    const expired = [];
    for (const row of rows) {
      const info = update.run(STATUS.EXPIRED, at, row.task_id, STATUS.QUEUED);
      if (Number(info.changes) === 1) expired.push(row);
    }
    return expired;
  }

  /**
   * Atomically pick up to `limit` deliverable tasks and lease them.
   * node:sqlite is synchronous, so select + update cannot interleave with another poll.
   *
   * 顺序不是纯 FIFO：主人的私聊排在最前，其次群聊，主动搭话排最后。她只有两个并发槽
   * （`maxConcurrentTurns`），一个群里聊得热闹的下午，他发一句「在吗」本来要等群里那七条
   * 走完——线上量到过 187 秒、604 秒的等待，全都花在这上面。
   */
  claim({ limit, at = this.now(), leaseMs = DELIVERING_LEASE_MS }) {
    this.reclaimExpiredLeases(at);
    const rows = this.db
      .prepare(
        `SELECT * FROM tasks WHERE status = ? AND deadline_at >= ?
         ORDER BY
           CASE
             WHEN proactive = 1 THEN 2
             WHEN is_owner = 1 AND kind = 'private' THEN 0
             ELSE 1
           END ASC,
           received_at ASC, rowid ASC
         LIMIT ?`,
      )
      .all(STATUS.QUEUED, at, limit);
    if (rows.length === 0) return [];
    const leaseUntil = at + leaseMs;
    const update = this.db.prepare(
      'UPDATE tasks SET status = ?, lease_until = ?, updated_at = ? WHERE task_id = ? AND status = ?',
    );
    const claimed = [];
    for (const row of rows) {
      const info = update.run(STATUS.DELIVERING, leaseUntil, at, row.task_id, STATUS.QUEUED);
      if (Number(info.changes) !== 1) continue;
      row.status = STATUS.DELIVERING;
      row.lease_until = leaseUntil;
      claimed.push(row);
    }
    return claimed;
  }

  /** POST /node/status accepted|running. Idempotent; unknown task -> found:false. */
  markRunning(taskId, { at = this.now(), leaseMs = RUNNING_LEASE_MS } = {}) {
    const row = this.getRow(taskId);
    if (!row) return { found: false };
    if (row.result_at !== null) return { found: true, row, terminal: true };
    this.db
      .prepare('UPDATE tasks SET status = ?, lease_until = ?, updated_at = ? WHERE task_id = ?')
      .run(STATUS.RUNNING, at + leaseMs, at, taskId);
    return { found: true, row: this.getRow(taskId), terminal: false };
  }

  /**
   * POST /node/result. The first submission wins; later ones are duplicates.
   * result_at acts as the duplicate marker and survives every status change.
   */
  recordResult(taskId, { ok, text, error = null, at = this.now() }) {
    const row = this.getRow(taskId);
    if (!row) return { found: false };
    if (row.result_at !== null) return { found: true, duplicate: true, row };
    this.db
      .prepare(
        `UPDATE tasks SET result_at = ?, result_ok = ?, result_text = ?, result_error = ?, updated_at = ?
         WHERE task_id = ? AND result_at IS NULL`,
      )
      .run(at, ok ? 1 : 0, text, error, at, taskId);
    return { found: true, duplicate: false, row: this.getRow(taskId) };
  }

  /** Final state after the reply was (or could not be) delivered to QQ. */
  finish(taskId, { ok, at = this.now() }) {
    this.db
      .prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE task_id = ?')
      .run(ok ? STATUS.DONE : STATUS.FAILED, at, taskId);
    return this.getRow(taskId);
  }
}
