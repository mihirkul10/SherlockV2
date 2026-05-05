/**
 * Admin state assembler.
 *
 * Pulls a single JSON snapshot of everything the live admin dashboard
 * needs to render: bridge health, active research, recent iMessage turns,
 * corpus size, source roster, ingestion-run history, and log tails.
 *
 * Read-only. Safe to call as often as the dashboard polls.
 */

import Database from "better-sqlite3";
import { existsSync, readFileSync, statSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  CONVERSATIONS_DB,
  RESEARCH_RUNS_DB,
  INDEX_DB,
  CONTEXT_RUNS_LOG,
  SOURCES_JSON,
  STATE_DIR,
  VAULT_REPORTS_DIR,
} from "../shared/paths.js";
import { homedir } from "node:os";

const HOME = homedir();
const BRIDGE_LOG = resolve(HOME, "Library", "Logs", "sherlock-bridge.log");
const INDEXER_LOG = resolve(HOME, "Library", "Logs", "sherlock-indexer.log");
const MCP_CTX_LOG = resolve(STATE_DIR, "mcp-context-search.log");

// ─── Helpers ──────────────────────────────────────────────────────────

function tailLines(path: string, n: number): string[] {
  if (!existsSync(path)) return [];
  try {
    const text = readFileSync(path, "utf-8");
    const lines = text.split("\n").filter((l) => l.length > 0);
    return lines.slice(-n);
  } catch { return []; }
}

function safeStmt<T>(db: Database.Database, sql: string, ...params: unknown[]): T | undefined {
  try { return db.prepare(sql).get(...params) as T; } catch { return undefined; }
}
function safeAll<T>(db: Database.Database, sql: string, ...params: unknown[]): T[] {
  try { return db.prepare(sql).all(...params) as T[]; } catch { return []; }
}

// ─── Public state shape ───────────────────────────────────────────────

export interface AdminSnapshot {
  generated_at: string;
  bridge: {
    pid: number;
    uptime_s: number;
    port: number;
  };
  research: {
    active: Array<{
      id: number; chat_guid: string; topic: string; status: string;
      started_at: number; elapsed_min: number;
      agent_id?: string; run_id?: string;
    }>;
    recent: Array<{
      id: number; chat_guid: string; topic: string; status: string;
      started_at: number; finished_at?: number;
      duration_min?: number; vault_path?: string; tldr?: string; error?: string;
    }>;
    counts_by_status: Record<string, number>;
  };
  conversations: {
    chats: Array<{
      chat_guid: string;
      message_count: number;
      last_ts: number;
      last_role: string;
      last_text: string;
    }>;
    recent_messages: Array<{
      chat_guid: string;
      role: string;
      text: string;
      ts: number;
    }>;
  };
  corpus: {
    total: number;
    by_source: Record<string, number>;
    last_indexed_at?: string;
  };
  sources: {
    counts: Record<string, number>;
    youtube?: Array<{ id?: string; channel_id?: string; handle?: string; name?: string }>;
    twitter_people?: Array<{ id?: string; handle?: string; name?: string }>;
    substack?: Array<{ id?: string; subdomain?: string; name?: string }>;
    blog?: Array<{ id?: string; url?: string; name?: string }>;
  };
  ingest_runs: Array<{
    ts: string; type: string; ok: boolean;
    items_added?: number; items_skipped?: number; items_failed?: number;
    error?: string;
  }>;
  vault: {
    reports_count: number;
    recent_reports: Array<{ name: string; path: string; modified_at: number; size: number }>;
  };
  logs: {
    bridge_tail: string[];
    indexer_tail: string[];
    mcp_context_tail: string[];
  };
}

// ─── Assembler ────────────────────────────────────────────────────────

const t0 = Date.now();
const myPid = process.pid;

export function buildSnapshot(opts: { port: number }): AdminSnapshot {
  const now = Date.now();

  // ─── research ──────────────────────────────────────────────────────
  let active: AdminSnapshot["research"]["active"] = [];
  let recent: AdminSnapshot["research"]["recent"] = [];
  let countsByStatus: Record<string, number> = {};
  if (existsSync(RESEARCH_RUNS_DB)) {
    const db = new Database(RESEARCH_RUNS_DB, { readonly: true, fileMustExist: true });
    try {
      const activeRows = safeAll<{
        id: number; chat_guid: string; topic: string; status: string;
        started_at: number; agent_id: string | null; run_id: string | null;
      }>(db, `SELECT id, chat_guid, topic, status, started_at, agent_id, run_id
              FROM research_runs WHERE status IN ('queued','running')
              ORDER BY started_at ASC`);
      active = activeRows.map((r) => {
        const baseObj: AdminSnapshot["research"]["active"][number] = {
          id: r.id, chat_guid: r.chat_guid, topic: r.topic, status: r.status,
          started_at: r.started_at,
          elapsed_min: Math.round(((now - r.started_at) / 60_000) * 10) / 10,
        };
        if (r.agent_id) baseObj.agent_id = r.agent_id;
        if (r.run_id) baseObj.run_id = r.run_id;
        return baseObj;
      });

      const recentRows = safeAll<{
        id: number; chat_guid: string; topic: string; status: string;
        started_at: number; finished_at: number | null;
        vault_path: string | null; tldr: string | null; error: string | null;
      }>(db, `SELECT id, chat_guid, topic, status, started_at, finished_at, vault_path, tldr, error
              FROM research_runs ORDER BY id DESC LIMIT 12`);
      recent = recentRows.map((r) => {
        const baseObj: AdminSnapshot["research"]["recent"][number] = {
          id: r.id, chat_guid: r.chat_guid, topic: r.topic, status: r.status,
          started_at: r.started_at,
        };
        if (r.finished_at) {
          baseObj.finished_at = r.finished_at;
          baseObj.duration_min = Math.round(((r.finished_at - r.started_at) / 60_000) * 10) / 10;
        }
        if (r.vault_path) baseObj.vault_path = r.vault_path;
        if (r.tldr) baseObj.tldr = r.tldr;
        if (r.error) baseObj.error = r.error;
        return baseObj;
      });

      const counts = safeAll<{ status: string; n: number }>(db,
        `SELECT status, COUNT(*) n FROM research_runs GROUP BY status`);
      countsByStatus = Object.fromEntries(counts.map((r) => [r.status, r.n]));
    } finally { db.close(); }
  }

  // ─── conversations ────────────────────────────────────────────────
  let chats: AdminSnapshot["conversations"]["chats"] = [];
  let recentMsgs: AdminSnapshot["conversations"]["recent_messages"] = [];
  if (existsSync(CONVERSATIONS_DB)) {
    const db = new Database(CONVERSATIONS_DB, { readonly: true, fileMustExist: true });
    try {
      const chatRows = safeAll<{
        chat_guid: string; message_count: number; last_ts: number;
        last_role: string; last_text: string;
      }>(db, `
        SELECT m.chat_guid,
               COUNT(*) AS message_count,
               MAX(m.ts) AS last_ts,
               (SELECT role FROM messages WHERE chat_guid=m.chat_guid ORDER BY ts DESC LIMIT 1) AS last_role,
               (SELECT substr(text,1,100) FROM messages WHERE chat_guid=m.chat_guid ORDER BY ts DESC LIMIT 1) AS last_text
        FROM messages m
        GROUP BY m.chat_guid
        ORDER BY last_ts DESC
        LIMIT 12
      `);
      chats = chatRows;

      const recentRows = safeAll<{ chat_guid: string; role: string; text: string; ts: number }>(
        db, `SELECT chat_guid, role, substr(text,1,400) text, ts FROM messages ORDER BY ts DESC LIMIT 30`
      );
      recentMsgs = recentRows;
    } finally { db.close(); }
  }

  // ─── corpus ────────────────────────────────────────────────────────
  let corpus: AdminSnapshot["corpus"] = { total: 0, by_source: {} };
  if (existsSync(INDEX_DB)) {
    const db = new Database(INDEX_DB, { readonly: true, fileMustExist: true });
    try {
      const total = safeStmt<{ n: number }>(db, `SELECT COUNT(*) n FROM docs`);
      const bySource = safeAll<{ source: string; n: number }>(db,
        `SELECT source, COUNT(*) n FROM docs GROUP BY source`);
      corpus = {
        total: total?.n ?? 0,
        by_source: Object.fromEntries(bySource.map((r) => [r.source, r.n])),
      };
      try {
        const stat = statSync(INDEX_DB);
        corpus.last_indexed_at = stat.mtime.toISOString();
      } catch { /* ignore */ }
    } finally { db.close(); }
  }

  // ─── sources roster ────────────────────────────────────────────────
  const sources: AdminSnapshot["sources"] = { counts: {} };
  if (existsSync(SOURCES_JSON)) {
    try {
      const text = readFileSync(SOURCES_JSON, "utf-8");
      const j = JSON.parse(text) as Record<string, unknown>;
      // sources.json actual shape (per repo):
      //   { youtube: { channels: [...] }, twitter: { people: [...], bookmarks: [...] },
      //     substack: { newsletters: [...] }, blog: { feeds: [...] } }
      // Try all the plausible nestings to be resilient to schema drift.
      const pickArr = (...paths: string[][]): unknown[] | null => {
        for (const p of paths) {
          let cur: unknown = j;
          for (const seg of p) {
            if (cur && typeof cur === "object" && seg in (cur as Record<string, unknown>)) {
              cur = (cur as Record<string, unknown>)[seg];
            } else { cur = null; break; }
          }
          if (Array.isArray(cur)) return cur;
        }
        return null;
      };

      const yt = pickArr(["youtube", "channels"], ["youtube"]);
      if (yt) { sources.counts["youtube"] = yt.length; sources.youtube = yt.slice(0, 60) as AdminSnapshot["sources"]["youtube"]; }

      const tw = pickArr(["twitter", "people"], ["twitter_people"], ["twitter-people"]);
      if (tw) { sources.counts["twitter_people"] = tw.length; sources.twitter_people = tw.slice(0, 60) as AdminSnapshot["sources"]["twitter_people"]; }

      const sub = pickArr(["substack", "newsletters"], ["substack"]);
      if (sub) { sources.counts["substack"] = sub.length; sources.substack = sub.slice(0, 60) as AdminSnapshot["sources"]["substack"]; }

      const blog = pickArr(["blog", "feeds"], ["blog"]);
      if (blog) { sources.counts["blog"] = blog.length; sources.blog = blog.slice(0, 60) as AdminSnapshot["sources"]["blog"]; }

      const bookmarks = pickArr(["twitter", "bookmarks"]);
      if (bookmarks) { sources.counts["twitter_bookmarks"] = bookmarks.length; }
    } catch { /* ignore */ }
  }

  // ─── ingest runs ───────────────────────────────────────────────────
  let ingestRuns: AdminSnapshot["ingest_runs"] = [];
  if (existsSync(CONTEXT_RUNS_LOG)) {
    try {
      const text = readFileSync(CONTEXT_RUNS_LOG, "utf-8");
      const lines = text.split("\n").filter((l) => l.length > 0);
      const tail = lines.slice(-20).reverse(); // newest first
      ingestRuns = tail.map((line) => {
        try {
          const obj = JSON.parse(line) as Record<string, unknown>;
          const out: AdminSnapshot["ingest_runs"][number] = {
            ts: String(obj["ts"] ?? obj["timestamp"] ?? ""),
            type: String(obj["type"] ?? obj["source"] ?? "unknown"),
            ok: Boolean(obj["ok"] ?? obj["success"] ?? false),
          };
          if (typeof obj["items_added"] === "number") out.items_added = obj["items_added"] as number;
          if (typeof obj["items_skipped"] === "number") out.items_skipped = obj["items_skipped"] as number;
          if (typeof obj["items_failed"] === "number") out.items_failed = obj["items_failed"] as number;
          if (typeof obj["error"] === "string") out.error = obj["error"] as string;
          return out;
        } catch { return { ts: "", type: "unparseable", ok: false }; }
      });
    } catch { /* ignore */ }
  }

  // ─── vault reports ─────────────────────────────────────────────────
  let recentReports: AdminSnapshot["vault"]["recent_reports"] = [];
  let reportsCount = 0;
  if (existsSync(VAULT_REPORTS_DIR)) {
    try {
      const allFiles: Array<{ name: string; path: string; modified_at: number; size: number }> = [];
      // Walk Reports/<yyyy-mm>/*.md (one level deep is sufficient for our layout).
      const monthDirs = readdirSync(VAULT_REPORTS_DIR, { withFileTypes: true });
      for (const d of monthDirs) {
        if (!d.isDirectory()) continue;
        // Skip _index.md and other non-month entries that aren't directories.
        const monthPath = resolve(VAULT_REPORTS_DIR, d.name);
        let entries: string[];
        try { entries = readdirSync(monthPath); } catch { continue; }
        for (const f of entries) {
          if (!f.endsWith(".md") || f.startsWith("_")) continue;
          const fp = resolve(monthPath, f);
          try {
            const s = statSync(fp);
            allFiles.push({ name: f, path: fp, modified_at: s.mtimeMs, size: s.size });
          } catch { /* ignore */ }
        }
      }
      reportsCount = allFiles.length;
      allFiles.sort((a, b) => b.modified_at - a.modified_at);
      recentReports = allFiles.slice(0, 8);
    } catch { /* ignore */ }
  }

  // ─── logs ──────────────────────────────────────────────────────────
  const logs = {
    bridge_tail: tailLines(BRIDGE_LOG, 50),
    indexer_tail: tailLines(INDEXER_LOG, 25),
    mcp_context_tail: tailLines(MCP_CTX_LOG, 25),
  };

  return {
    generated_at: new Date().toISOString(),
    bridge: { pid: myPid, uptime_s: Math.round((now - t0) / 1000), port: opts.port },
    research: { active, recent, counts_by_status: countsByStatus },
    conversations: { chats, recent_messages: recentMsgs },
    corpus,
    sources,
    ingest_runs: ingestRuns,
    vault: { reports_count: reportsCount, recent_reports: recentReports },
    logs,
  };
}
