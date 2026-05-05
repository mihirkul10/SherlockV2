/**
 * Per-chat conversation transcript store, backed by SQLite.
 *
 * The hybrid memory model from the plan: each iMessage turn loads recent
 * history into the prompt for a fresh local SDK agent (instead of using
 * Agent.resume across turns). Restart-survival comes for free.
 *
 * Schema:
 *   messages       — every inbound + outbound message
 *   imessage_runs  — one row per agent turn (latency tracking, status)
 */

import Database, { type Database as DB } from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { CONVERSATIONS_DB } from "../shared/paths.js";
import { createLogger } from "../shared/logger.js";

const log = createLogger("bridge:conversation");

let db: DB | null = null;

export function getConversationDb(): DB {
  if (db) return db;
  mkdirSync(dirname(CONVERSATIONS_DB), { recursive: true });
  db = new Database(CONVERSATIONS_DB);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_guid   TEXT NOT NULL,
      role        TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
      text        TEXT NOT NULL,
      ts          INTEGER NOT NULL,
      message_id  TEXT,
      run_id      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages(chat_guid, ts DESC);
    -- Plain (non-unique) index on message_id for fast hasMessageId() lookups.
    -- We don't enforce uniqueness here because (a) hasMessageId() in code
    -- already prevents duplicate inserts, and (b) a UNIQUE INDEX would fail
    -- to create on databases where historic dupes exist (older runs without
    -- the idempotency check), which would break the entire DB open.
    CREATE INDEX IF NOT EXISTS idx_messages_message_id
      ON messages(message_id) WHERE message_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS imessage_runs (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_guid    TEXT NOT NULL,
      agent_id     TEXT,
      run_id       TEXT,
      status       TEXT NOT NULL CHECK(status IN ('running','finished','error','timeout')),
      started_at   INTEGER NOT NULL,
      finished_at  INTEGER,
      latency_ms   INTEGER,
      error        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_runs_chat_ts ON imessage_runs(chat_guid, started_at DESC);
  `);
  log.info({ path: CONVERSATIONS_DB }, "conversations db opened");
  return db;
}

export function closeConversationDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// ─── Messages ─────────────────────────────────────────────────────────

export interface StoredMessage {
  id: number;
  chat_guid: string;
  role: "user" | "assistant" | "system";
  text: string;
  ts: number;
  message_id: string | null;
  run_id: string | null;
}

export function appendMessage(args: {
  chat_guid: string;
  role: "user" | "assistant" | "system";
  text: string;
  ts?: number;
  message_id?: string;
  run_id?: string;
}): number {
  const d = getConversationDb();
  const info = d.prepare(`
    INSERT INTO messages (chat_guid, role, text, ts, message_id, run_id)
    VALUES (@chat_guid, @role, @text, @ts, @message_id, @run_id)
  `).run({
    chat_guid: args.chat_guid,
    role: args.role,
    text: args.text,
    ts: args.ts ?? Date.now(),
    message_id: args.message_id ?? null,
    run_id: args.run_id ?? null,
  });
  return Number(info.lastInsertRowid);
}

/** Returns true if a message with this message_id has already been stored.
 *  Used by handleInbound to skip duplicate inbound dispatches when both
 *  transports (chat.db poller + a residual BB webhook) detect the same msg. */
export function hasMessageId(message_id: string): boolean {
  if (!message_id) return false;
  const d = getConversationDb();
  const row = d.prepare("SELECT 1 FROM messages WHERE message_id = ? LIMIT 1").get(message_id);
  return !!row;
}

export function recentMessages(chat_guid: string, limit = 20): StoredMessage[] {
  const d = getConversationDb();
  const rows = d.prepare(`
    SELECT id, chat_guid, role, text, ts, message_id, run_id
    FROM messages
    WHERE chat_guid = ?
    ORDER BY ts DESC
    LIMIT ?
  `).all(chat_guid, limit) as StoredMessage[];
  return rows.reverse(); // chronological
}

// ─── iMessage runs ────────────────────────────────────────────────────

export function startRun(chat_guid: string): number {
  const d = getConversationDb();
  const info = d.prepare(`
    INSERT INTO imessage_runs (chat_guid, status, started_at)
    VALUES (?, 'running', ?)
  `).run(chat_guid, Date.now());
  return Number(info.lastInsertRowid);
}

export function setRunIds(id: number, agent_id: string, run_id: string): void {
  getConversationDb().prepare(`
    UPDATE imessage_runs SET agent_id=?, run_id=? WHERE id=?
  `).run(agent_id, run_id, id);
}

export function finishRun(id: number, status: "finished" | "error" | "timeout", error?: string): void {
  const d = getConversationDb();
  const now = Date.now();
  d.prepare(`
    UPDATE imessage_runs
    SET status=?, finished_at=?, latency_ms=(?-started_at), error=?
    WHERE id=?
  `).run(status, now, now, error ?? null, id);
}

export interface RunSummary {
  id: number;
  chat_guid: string;
  agent_id: string | null;
  status: string;
  started_at: number;
  finished_at: number | null;
  latency_ms: number | null;
  error: string | null;
}

export function recentRuns(limit = 25): RunSummary[] {
  return getConversationDb().prepare(`
    SELECT id, chat_guid, agent_id, status, started_at, finished_at, latency_ms, error
    FROM imessage_runs
    ORDER BY started_at DESC
    LIMIT ?
  `).all(limit) as RunSummary[];
}
