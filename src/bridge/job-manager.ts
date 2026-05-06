/**
 * Research job manager — the orchestration heart of Sherlock-Researcher.
 *
 * Owns:
 *   - research-runs.sqlite (durable state, survives bridge restarts)
 *   - In-memory live registry of currently-spawned researcher agents
 *   - Hard concurrency cap (MAX_CONCURRENT_RESEARCHERS, default 3)
 *   - FIFO queue when over cap
 *   - 30-min hard timeout per researcher
 *   - On finish/error/cancel: dispose agent, free slot, drain queue
 *
 * Sherlock-Front never spawns researchers itself. It calls
 * `requestResearch(scope)` on this manager via the research-control MCP.
 *
 * The bridge wires this to:
 *   - POST /research/:id/cancel  → cancelRun(id)
 *   - GET  /state                → snapshot()
 *   - tools/research-control/server.ts (the MCP exposed to Front)
 */

import Database, { type Database as DB } from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { SDKAgent, RunResult } from "@cursor/sdk";
import { RESEARCH_RUNS_DB } from "../shared/paths.js";
import { createLogger } from "../shared/logger.js";

const log = createLogger("bridge:job-manager");

export const MAX_CONCURRENT_RESEARCHERS = parseInt(
  process.env["MAX_CONCURRENT_RESEARCHERS"] ?? "3",
  10,
);
const HARD_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const ETA_MINUTES_DEFAULT = 10;

// ─── Schema ───────────────────────────────────────────────────────────

export type ResearchStatus = "queued" | "running" | "complete" | "error" | "cancelled";

export interface ResearchScope {
  topic: string;
  dimensions?: string[];
  time_horizon?: string;
  sources_focus?: string[];
  urgency?: "low" | "normal" | "high";
  notes?: string;
  index_brief?: string;
  followup_questions?: string[];
}

export interface ResearchRun {
  id: number;
  chat_guid: string;
  topic: string;
  scope_json: string;
  status: ResearchStatus;
  agent_id: string | null;
  run_id: string | null;
  started_at: number;
  finished_at: number | null;
  vault_path: string | null;
  tldr: string | null;
  error: string | null;
  parent_msg_id: string | null;
}

let db: DB | null = null;

function getDb(): DB {
  if (db) return db;
  mkdirSync(dirname(RESEARCH_RUNS_DB), { recursive: true });
  db = new Database(RESEARCH_RUNS_DB);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS research_runs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_guid     TEXT NOT NULL,
      topic         TEXT NOT NULL,
      scope_json    TEXT NOT NULL,
      status        TEXT NOT NULL CHECK(status IN ('queued','running','complete','error','cancelled')),
      agent_id      TEXT,
      run_id        TEXT,
      started_at    INTEGER NOT NULL,
      finished_at   INTEGER,
      vault_path    TEXT,
      tldr          TEXT,
      error         TEXT,
      parent_msg_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_research_status ON research_runs(status, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_research_chat   ON research_runs(chat_guid, started_at DESC);
  `);
  log.info({ path: RESEARCH_RUNS_DB }, "research-runs db opened");
  return db;
}

export function closeJobManagerDb(): void {
  if (db) { db.close(); db = null; }
}

// ─── In-memory live registry ──────────────────────────────────────────

interface LiveEntry {
  agent: SDKAgent;
  cancel?: () => Promise<void>;
  startedAt: number;
  timer: NodeJS.Timeout;
}

const liveById = new Map<number, LiveEntry>();

// ─── Spawner contract ─────────────────────────────────────────────────
//
// The job manager doesn't import the researcher-runner directly to keep the
// dependency loop one-way. Instead, the bridge wires this callback at startup.
// The callback returns a started SDKAgent + a cancel function + a promise that
// resolves with the final RunResult.

export interface SpawnResult {
  agent: SDKAgent;
  result: Promise<{ runResult: RunResult; vaultPath?: string; tldr?: string }>;
  runId: string;
  /** Optional explicit cancel that calls run.cancel() on the underlying SDK Run. */
  cancel?: () => Promise<void>;
}

export type ResearcherSpawner = (args: {
  research_id: number;
  chat_guid: string;
  scope: ResearchScope;
}) => Promise<SpawnResult>;

let spawner: ResearcherSpawner | null = null;

export function setResearcherSpawner(s: ResearcherSpawner): void {
  spawner = s;
}

// ─── Public API ───────────────────────────────────────────────────────

export interface RequestResult {
  research_id: number;
  status: ResearchStatus;
  queue_position: number; // 0 = running immediately
  eta_minutes: number;
  active_count: number;
}

export function requestResearch(args: {
  chat_guid: string;
  scope: ResearchScope;
  parent_msg_id?: string;
}): RequestResult {
  const dbi = getDb();
  const runningCount = countByStatus("running");
  const willRun = runningCount < MAX_CONCURRENT_RESEARCHERS;

  const status: ResearchStatus = willRun ? "running" : "queued";
  const info = dbi.prepare(`
    INSERT INTO research_runs (chat_guid, topic, scope_json, status, started_at, parent_msg_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    args.chat_guid,
    args.scope.topic,
    JSON.stringify(args.scope),
    status,
    Date.now(),
    args.parent_msg_id ?? null,
  );
  const id = Number(info.lastInsertRowid);

  if (willRun) {
    void launchResearcher(id);
  }

  const queuedAhead = countByStatus("queued") - (willRun ? 0 : 1);
  return {
    research_id: id,
    status,
    queue_position: willRun ? 0 : Math.max(0, queuedAhead),
    eta_minutes: ETA_MINUTES_DEFAULT * (willRun ? 1 : 1 + queuedAhead),
    active_count: countByStatus("running"),
  };
}

async function launchResearcher(id: number): Promise<void> {
  if (!spawner) {
    log.error({ id }, "no spawner registered — cannot launch researcher");
    finishRow(id, "error", { error: "spawner not registered" });
    drainQueue();
    return;
  }
  const row = getRow(id);
  if (!row) return;

  const scope = JSON.parse(row.scope_json) as ResearchScope;
  log.info({ id, topic: scope.topic }, "launching researcher");

  let entry: LiveEntry | undefined;
  try {
    const spawn = await spawner({ research_id: id, chat_guid: row.chat_guid, scope });
    setRunIds(id, spawn.agent.agentId, spawn.runId);

    const timer = setTimeout(() => {
      log.warn({ id }, "researcher hit hard timeout, cancelling");
      void cancelRun(id, "timeout");
    }, HARD_TIMEOUT_MS);

    entry = {
      agent: spawn.agent,
      startedAt: Date.now(),
      timer,
      ...(spawn.cancel && { cancel: spawn.cancel }),
    };
    liveById.set(id, entry);

    const { runResult, vaultPath, tldr } = await spawn.result;
    clearTimeout(timer);

    if (runResult.status === "finished") {
      finishRow(id, "complete", { vault_path: vaultPath ?? null, tldr: tldr ?? null });
      log.info({ id, vault_path: vaultPath, durMs: Date.now() - row.started_at }, "✓ researcher complete");
    } else if (runResult.status === "cancelled") {
      finishRow(id, "cancelled");
    } else {
      finishRow(id, "error", { error: `run status=${runResult.status}` });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ id, err: msg }, "researcher launch crashed");
    if (entry?.timer) clearTimeout(entry.timer);
    finishRow(id, "error", { error: msg });
  } finally {
    const live = liveById.get(id);
    if (live) {
      try { await live.agent[Symbol.asyncDispose](); } catch (e) {
        log.warn({ id, err: e instanceof Error ? e.message : String(e) }, "agent dispose failed");
      }
      liveById.delete(id);
    }
    drainQueue();
  }
}

function drainQueue(): void {
  const dbi = getDb();
  while (countByStatus("running") < MAX_CONCURRENT_RESEARCHERS) {
    const next = dbi.prepare(
      `SELECT id FROM research_runs WHERE status='queued' ORDER BY started_at ASC LIMIT 1`,
    ).get() as { id: number } | undefined;
    if (!next) return;
    dbi.prepare(`UPDATE research_runs SET status='running', started_at=? WHERE id=?`).run(Date.now(), next.id);
    log.info({ id: next.id }, "promoted queued researcher to running");
    void launchResearcher(next.id);
  }
}

export async function cancelRun(id: number, reason: "user" | "timeout" = "user"): Promise<boolean> {
  const live = liveById.get(id);
  log.info({ id, reason, isLive: !!live }, "cancel requested");
  // Mark cancelled FIRST so any later finishRow call is a no-op (terminal state).
  finishRow(id, "cancelled", { error: reason === "timeout" ? "hard timeout" : "user-cancelled" });
  if (live) {
    if (live.cancel) {
      try { await live.cancel(); } catch (e) {
        log.warn({ id, err: e instanceof Error ? e.message : String(e) }, "run.cancel failed");
      }
    }
    try {
      await live.agent[Symbol.asyncDispose]();
    } catch (e) {
      log.warn({ id, err: e instanceof Error ? e.message : String(e) }, "cancel dispose failed");
    }
    clearTimeout(live.timer);
    liveById.delete(id);
  }
  drainQueue();
  return true;
}

// ─── Queries ──────────────────────────────────────────────────────────

export function listActive(): ResearchRun[] {
  return getDb().prepare(
    `SELECT * FROM research_runs WHERE status IN ('running','queued') ORDER BY started_at ASC`,
  ).all() as ResearchRun[];
}

export function listRecent(limit = 25): ResearchRun[] {
  return getDb().prepare(
    `SELECT * FROM research_runs ORDER BY started_at DESC LIMIT ?`,
  ).all(limit) as ResearchRun[];
}

export function getRow(id: number): ResearchRun | null {
  const r = getDb().prepare(`SELECT * FROM research_runs WHERE id=?`).get(id) as ResearchRun | undefined;
  return r ?? null;
}

function countByStatus(status: ResearchStatus): number {
  return (getDb().prepare(`SELECT COUNT(*) as n FROM research_runs WHERE status=?`).get(status) as { n: number }).n;
}

function setRunIds(id: number, agent_id: string, run_id: string): void {
  getDb().prepare(`UPDATE research_runs SET agent_id=?, run_id=? WHERE id=?`).run(agent_id, run_id, id);
}

function finishRow(
  id: number,
  status: Extract<ResearchStatus, "complete" | "error" | "cancelled">,
  fields: { vault_path?: string | null; tldr?: string | null; error?: string } = {},
): void {
  const dbi = getDb();
  // Don't overwrite a row that's already in a terminal state (especially
  // 'cancelled' — protects against the race where launchResearcher's then-branch
  // fires after cancelRun has already marked the row).
  const cur = dbi.prepare(`SELECT status FROM research_runs WHERE id=?`).get(id) as { status: ResearchStatus } | undefined;
  if (cur && (cur.status === "cancelled" || cur.status === "complete")) {
    log.debug({ id, currentStatus: cur.status, attemptedStatus: status }, "skip overwrite of terminal status");
    return;
  }
  dbi.prepare(`
    UPDATE research_runs
    SET status=?, finished_at=?, vault_path=COALESCE(?, vault_path), tldr=COALESCE(?, tldr), error=COALESCE(?, error)
    WHERE id=?
  `).run(
    status,
    Date.now(),
    fields.vault_path ?? null,
    fields.tldr ?? null,
    fields.error ?? null,
    id,
  );
}

// ─── Bridge restart recovery ──────────────────────────────────────────

/** Mark any 'running' rows as 'error' on bridge startup — they died with the
 * previous bridge process. (Future: try Agent.resume; for MVP, surface for retry.) */
export function recoverOrphans(): number {
  const dbi = getDb();
  const orphans = dbi.prepare(`SELECT id FROM research_runs WHERE status='running'`).all() as { id: number }[];
  for (const o of orphans) {
    finishRow(o.id, "error", { error: "orphaned by bridge restart" });
  }
  if (orphans.length > 0) log.warn({ count: orphans.length }, "marked orphaned researchers as error");
  return orphans.length;
}

// ─── Snapshot for /state ──────────────────────────────────────────────

export interface JobManagerSnapshot {
  cap: number;
  active_count: number;
  queued_count: number;
  active: ResearchRun[];
  recent_completed: ResearchRun[];
}

export function snapshot(): JobManagerSnapshot {
  const active = listActive();
  return {
    cap: MAX_CONCURRENT_RESEARCHERS,
    active_count: active.filter((r) => r.status === "running").length,
    queued_count: active.filter((r) => r.status === "queued").length,
    active,
    recent_completed: getDb()
      .prepare(`SELECT * FROM research_runs WHERE status IN ('complete','error','cancelled') ORDER BY finished_at DESC LIMIT 10`)
      .all() as ResearchRun[],
  };
}
