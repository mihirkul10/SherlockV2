/**
 * iMessage chat.db poller.
 *
 * Replaces BlueBubbles' webhook for inbound. Polls Apple's
 * `~/Library/Messages/chat.db` directly every N ms (default 1000ms).
 *
 * Why: BlueBubbles' inbound pipeline on macOS Tahoe (FSEvents-based file
 * watcher + Private API helper) is unreliable — webhooks intermittently
 * stop firing for messages BB itself can see in chat.db. We need 100%
 * inbound reliability for a personal assistant. SQLite polling at 1s
 * is rock-solid, low-CPU (one indexed query per tick), and gives us
 * full control over recovery.
 *
 * Requires: the bridge process must have Full Disk Access (TCC) for the
 * node binary at /Users/.../.nvm/versions/node/<version>/bin/node.
 *
 * Persistence: last-seen ROWID is written to state/imessage-poller-state.json
 * so we survive bridge restarts without reprocessing or missing messages.
 */

import Database from "better-sqlite3";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { STATE_DIR } from "../shared/paths.js";
import { createLogger } from "../shared/logger.js";

const log = createLogger("bridge:imessage-poller");

const CHAT_DB_PATH = resolve(homedir(), "Library", "Messages", "chat.db");
const POLLER_STATE_PATH = resolve(STATE_DIR, "imessage-poller-state.json");

// Cocoa reference epoch: 2001-01-01 00:00:00 UTC, in unix seconds.
const COCOA_EPOCH_UNIX_S = 978_307_200;

// ─── Types ────────────────────────────────────────────────────────────

export interface PolledMessage {
  rowid: number;
  guid: string;
  text: string;
  chat_guid: string;     // e.g. "iMessage;-;mihirkul10@gmail.com"
  sender: string;        // e.g. "mihirkul10@gmail.com" (handle.id)
  ts: number;            // unix ms
}

export type InboundHandler = (msg: PolledMessage) => Promise<void> | void;

// ─── Persisted state ──────────────────────────────────────────────────

interface PollerState {
  last_seen_rowid: number;
  last_polled_at: number;
}

function loadState(): PollerState {
  if (!existsSync(POLLER_STATE_PATH)) {
    return { last_seen_rowid: 0, last_polled_at: 0 };
  }
  try {
    return JSON.parse(readFileSync(POLLER_STATE_PATH, "utf-8")) as PollerState;
  } catch {
    return { last_seen_rowid: 0, last_polled_at: 0 };
  }
}

function saveState(s: PollerState): void {
  try {
    mkdirSync(dirname(POLLER_STATE_PATH), { recursive: true });
    writeFileSync(POLLER_STATE_PATH, JSON.stringify(s, null, 2), "utf-8");
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, "failed to persist poller state");
  }
}

// ─── Apple Cocoa date → unix ms ───────────────────────────────────────

function cocoaToUnixMs(rawDate: number | bigint): number {
  // Apple stores `date` as either:
  //   - seconds since Cocoa epoch (older Messages versions)
  //   - nanoseconds since Cocoa epoch (modern)
  // We sniff: anything > 10^11 is nanoseconds (else it'd be year 5000+ in seconds).
  const n = typeof rawDate === "bigint" ? Number(rawDate) : rawDate;
  if (n > 1e15) {
    // nanoseconds
    return Math.round(n / 1_000_000) + COCOA_EPOCH_UNIX_S * 1000;
  }
  // seconds
  return n * 1000 + COCOA_EPOCH_UNIX_S * 1000;
}

// ─── The poller ───────────────────────────────────────────────────────

export interface PollerOptions {
  intervalMs?: number;
  onMessage: InboundHandler;
  /** If true and last_seen_rowid is 0, initialize to the current max ROWID
   *  (i.e. ignore historic messages). Otherwise we'd reply to every
   *  message from the start of chat.db on first run. Default true. */
  skipBacklogOnFirstRun?: boolean;
}

export class IMessagePoller {
  private timer: NodeJS.Timeout | null = null;
  private state: PollerState;
  private db: Database.Database | null = null;
  private inFlight = false;

  constructor(private readonly opts: PollerOptions) {
    this.state = loadState();
  }

  start(): void {
    if (this.timer) return;
    if (!existsSync(CHAT_DB_PATH)) {
      log.error({ path: CHAT_DB_PATH }, "chat.db not found");
      return;
    }
    try {
      this.db = new Database(CHAT_DB_PATH, { readonly: true, fileMustExist: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Most common failure: "authorization denied" → bridge process lacks
      // Full Disk Access (TCC). Tell the user clearly what to do.
      if (/authorization|denied|permission/i.test(msg)) {
        log.error({
          path: CHAT_DB_PATH,
          err: msg,
          fix: "Grant Full Disk Access to the node binary (System Settings → Privacy & Security → Full Disk Access → +). Find node with `which node`.",
        }, "chat.db permission denied — Full Disk Access required");
      } else {
        log.error({ path: CHAT_DB_PATH, err: msg }, "failed to open chat.db");
      }
      return;
    }

    // First-run guard: skip the whole backlog, only respond to messages
    // arriving from now on.
    if (this.opts.skipBacklogOnFirstRun !== false && this.state.last_seen_rowid === 0) {
      const maxRow = this.db.prepare("SELECT MAX(ROWID) AS r FROM message").get() as { r: number | null };
      this.state.last_seen_rowid = maxRow.r ?? 0;
      saveState(this.state);
      log.info({ initial_rowid: this.state.last_seen_rowid }, "first run — skipping historic backlog");
    }

    const interval = this.opts.intervalMs ?? 1000;
    log.info({ intervalMs: interval, last_seen_rowid: this.state.last_seen_rowid }, "iMessage poller started");
    this.timer = setInterval(() => { void this.tick(); }, interval);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.db) { try { this.db.close(); } catch { /* ignore */ } this.db = null; }
    log.info("iMessage poller stopped");
  }

  private async tick(): Promise<void> {
    if (this.inFlight) return; // avoid overlapping ticks if a handler is slow
    this.inFlight = true;
    try {
      if (!this.db) return;

      // The query joins message → chat_message_join → chat → handle to get
      // both the chat GUID (where to reply) and the sender's handle id.
      // Filter:
      //   - is_from_me = 0  (only inbound; we don't reply to our own sends)
      //   - text non-null + non-empty (skip image-only/reactions/edits with no body)
      //   - ROWID > last_seen_rowid (only new rows)
      const rows = this.db.prepare(`
        SELECT
          m.ROWID                 AS rowid,
          m.guid                  AS guid,
          m.text                  AS text,
          m.is_from_me            AS is_from_me,
          m.date                  AS date,
          c.guid                  AS chat_guid,
          h.id                    AS sender
        FROM message m
        JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
        JOIN chat c                ON c.ROWID        = cmj.chat_id
        LEFT JOIN handle h         ON h.ROWID        = m.handle_id
        WHERE m.ROWID > ?
          AND m.is_from_me = 0
          AND m.text IS NOT NULL
          AND length(trim(m.text)) > 0
        ORDER BY m.ROWID ASC
        LIMIT 100
      `).all(this.state.last_seen_rowid) as Array<{
        rowid: number; guid: string; text: string; is_from_me: number;
        date: number | bigint; chat_guid: string; sender: string | null;
      }>;

      if (rows.length === 0) {
        // Bump the persisted timestamp so we can tell from disk that the
        // poller is alive even when there's no traffic.
        const now = Date.now();
        if (now - this.state.last_polled_at > 30_000) {
          this.state.last_polled_at = now;
          saveState(this.state);
        }
        return;
      }

      log.info({ new_rows: rows.length, since_rowid: this.state.last_seen_rowid }, "new messages detected");

      let highestRowid = this.state.last_seen_rowid;
      for (const r of rows) {
        try {
          const msg: PolledMessage = {
            rowid: r.rowid,
            guid: r.guid,
            text: r.text,
            chat_guid: r.chat_guid,
            sender: r.sender ?? "(unknown)",
            ts: cocoaToUnixMs(r.date),
          };
          // Fire the handler. We don't await per-row to avoid blocking the
          // whole batch on one slow Sherlock turn — but we also don't fire
          // them in parallel without backpressure; the handler decides.
          await this.opts.onMessage(msg);
        } catch (err) {
          log.error({ rowid: r.rowid, err: err instanceof Error ? err.message : String(err) }, "handler threw");
        }
        if (r.rowid > highestRowid) highestRowid = r.rowid;
      }

      this.state.last_seen_rowid = highestRowid;
      this.state.last_polled_at = Date.now();
      saveState(this.state);
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, "tick failed");
    } finally {
      this.inFlight = false;
    }
  }
}
