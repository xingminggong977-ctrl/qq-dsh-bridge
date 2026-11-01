import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  task_id      TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  group_id     TEXT,
  user_id      TEXT NOT NULL,
  nickname     TEXT NOT NULL,
  text         TEXT NOT NULL,
  images       TEXT NOT NULL,
  received_at  INTEGER NOT NULL,
  deadline_at  INTEGER NOT NULL,
  is_owner     INTEGER NOT NULL,
  mentioned    INTEGER NOT NULL DEFAULT 1,
  needs_reply  INTEGER NOT NULL DEFAULT 1,
  proactive    INTEGER NOT NULL DEFAULT 0,
  proactive_cue TEXT NOT NULL DEFAULT '',
  origin       TEXT NOT NULL DEFAULT 'qq',
  reply_target TEXT NOT NULL,
  status       TEXT NOT NULL,
  lease_until  INTEGER NOT NULL DEFAULT 0,
  result_at    INTEGER,
  result_ok    INTEGER,
  result_text  TEXT,
  result_error TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_pickup ON tasks (status, deadline_at, received_at);
CREATE INDEX IF NOT EXISTS idx_tasks_lease ON tasks (status, lease_until);

CREATE TABLE IF NOT EXISTS blobs (
  blob_id    TEXT PRIMARY KEY,
  mime       TEXT NOT NULL,
  bytes      INTEGER NOT NULL,
  file_name  TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_events (
  user_id TEXT NOT NULL,
  ts      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_events_user ON rate_events (user_id, ts);

CREATE TABLE IF NOT EXISTS rate_notices (
  user_id TEXT PRIMARY KEY,
  last_at INTEGER NOT NULL
);
`;

/**
 * CREATE TABLE IF NOT EXISTS never alters a table that already exists, so a queue.db
 * written by the mention-only bridge needs the v2 columns added explicitly.
 * The defaults keep every pre-existing row on the old behaviour (mentioned, needs reply).
 */
const ADDED_COLUMNS = [
  ['mentioned', 'INTEGER NOT NULL DEFAULT 1'],
  ['needs_reply', 'INTEGER NOT NULL DEFAULT 1'],
  // Every pre-existing row was a real incoming message, so 0 is the correct default.
  ['proactive', 'INTEGER NOT NULL DEFAULT 0'],
  // 旧行没有由头，空串就是「这条主动开口没有世界那边的理由」。
  ['proactive_cue', "TEXT NOT NULL DEFAULT ''"],
  // Every pre-existing row came in through QQ, so 'qq' is the correct default; only
  // /node/ask writes 'ask', and that value is what keeps a reply out of QQ delivery.
  ['origin', "TEXT NOT NULL DEFAULT 'qq'"],
];

function migrate(db) {
  const present = new Set(db.prepare('PRAGMA table_info(tasks)').all().map((column) => column.name));
  for (const [name, definition] of ADDED_COLUMNS) {
    if (present.has(name)) continue;
    db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${definition}`);
  }
}

export function openDb(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}
