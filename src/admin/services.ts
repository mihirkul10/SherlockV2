/**
 * launchctl wrapper for the master Start/Stop Sherlock button.
 *
 * Controls Sherlock's primary launchd services. The admin's own label
 * (com.sherlock.admin) is intentionally NOT in the allow-list, so the
 * UI can never bootout itself.
 *
 * All shell-outs use execFile with array args (no shell, no injection).
 * Service labels are validated against the allow-list before any launchctl
 * call so a typo or hostile request can't reach the shell at all.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { homedir, userInfo } from "node:os";
import { existsSync } from "node:fs";

const execFileP = promisify(execFile);

const HOME = homedir();
const LAUNCHAGENTS = resolve(HOME, "Library", "LaunchAgents");

/** The primary services the master button controls. Order = start order. */
export const SHERLOCK_SERVICES = [
  "com.sherlock.context-sync",
  "com.sherlock.context-index-sync",
  "com.sherlock.vault-sync",
  "com.sherlock.bridge",
] as const;

export type ServiceLabel = (typeof SHERLOCK_SERVICES)[number];

const SERVICE_SET = new Set<string>(SHERLOCK_SERVICES);

function assertAllowed(label: string): asserts label is ServiceLabel {
  if (!SERVICE_SET.has(label)) {
    throw new Error(`refused: ${label} is not in the Sherlock service allow-list`);
  }
}

function uid(): number {
  return userInfo().uid;
}

function domainTarget(label: ServiceLabel): string {
  return `gui/${uid()}/${label}`;
}

function plistPath(label: ServiceLabel): string {
  return resolve(LAUNCHAGENTS, `${label}.plist`);
}

export interface ServiceStatus {
  label: ServiceLabel;
  loaded: boolean;
  state: "running" | "not running" | "unknown" | "unloaded";
  pid?: number;
  last_exit_code?: number | "never exited";
}

/**
 * Status of one service via `launchctl print`. Returns loaded=false when
 * the service has been bootedout (launchctl print exits non-zero).
 */
export async function statusOf(label: string): Promise<ServiceStatus> {
  assertAllowed(label);
  try {
    const { stdout } = await execFileP("launchctl", ["print", domainTarget(label)]);
    const out: ServiceStatus = { label, loaded: true, state: "unknown" };
    const stateMatch = stdout.match(/^\s*state\s*=\s*(\S.*?)\s*$/m);
    if (stateMatch && stateMatch[1]) {
      const v = stateMatch[1].trim();
      if (v === "running") out.state = "running";
      else if (v === "not running") out.state = "not running";
    }
    const pidMatch = stdout.match(/^\s*pid\s*=\s*(\d+)\s*$/m);
    if (pidMatch && pidMatch[1]) out.pid = parseInt(pidMatch[1], 10);
    const exitMatch = stdout.match(/^\s*last exit code\s*=\s*(.+?)\s*$/m);
    if (exitMatch && exitMatch[1]) {
      const v = exitMatch[1].trim();
      if (v === "(never exited)") out.last_exit_code = "never exited";
      else {
        const n = parseInt(v, 10);
        if (!Number.isNaN(n)) out.last_exit_code = n;
      }
    }
    return out;
  } catch {
    return { label, loaded: false, state: "unloaded" };
  }
}

export interface AllStatus {
  services: ServiceStatus[];
  running: number;
  total: number;
  state: "running" | "stopped" | "partial";
}

/**
 * Status of all primary Sherlock services + a summary state for the button.
 *
 * Note on "running": context-sync and vault-sync are StartInterval cron jobs
 * (fire every 60s, exit, idle). They're "loaded" continuously but only
 * `state=running` briefly during a tick. So the master button treats
 * "loaded in launchd" as the real signal of "Sherlock is on" — that's what
 * Stop/Start actually toggles via bootout/bootstrap.
 */
export async function statusAll(): Promise<AllStatus> {
  const services = await Promise.all(
    SHERLOCK_SERVICES.map((s) => statusOf(s))
  );
  const running = services.filter((s) => s.loaded).length;
  const total = services.length;
  let state: AllStatus["state"];
  if (running === 0) state = "stopped";
  else if (running === total) state = "running";
  else state = "partial";
  return { services, running, total, state };
}

/** Load (start) one service via `launchctl bootstrap`. No-op if already loaded. */
export async function startOne(label: string): Promise<{ ok: boolean; message: string }> {
  assertAllowed(label);
  const plist = plistPath(label);
  if (!existsSync(plist)) {
    return { ok: false, message: `plist not found: ${plist} (run launchd/install.sh)` };
  }
  // Check current state — bootstrap of an already-loaded service errors with code 17.
  const cur = await statusOf(label);
  if (cur.loaded) return { ok: true, message: `${label} already loaded` };
  try {
    await execFileP("launchctl", ["bootstrap", `gui/${uid()}`, plist]);
    return { ok: true, message: `${label} bootstrapped` };
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    return { ok: false, message: `bootstrap ${label} failed: ${e.stderr ?? e.message ?? "unknown"}` };
  }
}

/** Unload (stop) one service via `launchctl bootout`. No-op if already unloaded. */
export async function stopOne(label: string): Promise<{ ok: boolean; message: string }> {
  assertAllowed(label);
  const cur = await statusOf(label);
  if (!cur.loaded) return { ok: true, message: `${label} already stopped` };
  try {
    await execFileP("launchctl", ["bootout", domainTarget(label)]);
    return { ok: true, message: `${label} bootedout` };
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    return { ok: false, message: `bootout ${label} failed: ${e.stderr ?? e.message ?? "unknown"}` };
  }
}

export interface BulkResult {
  ok: boolean;
  results: Array<{ label: ServiceLabel; ok: boolean; message: string }>;
}

/** Start every Sherlock service that isn't currently loaded. */
export async function startAll(): Promise<BulkResult> {
  const results: BulkResult["results"] = [];
  for (const label of SHERLOCK_SERVICES) {
    const r = await startOne(label);
    results.push({ label, ok: r.ok, message: r.message });
  }
  return { ok: results.every((r) => r.ok), results };
}

/** Stop every Sherlock service that's currently loaded. */
export async function stopAll(): Promise<BulkResult> {
  const results: BulkResult["results"] = [];
  // Reverse order: bridge before its support services.
  for (const label of [...SHERLOCK_SERVICES].reverse()) {
    const r = await stopOne(label);
    results.push({ label, ok: r.ok, message: r.message });
  }
  return { ok: results.every((r) => r.ok), results };
}
