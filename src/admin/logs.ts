/**
 * Log file registry for the admin Logs viewer.
 *
 * Hard-coded allow-list of log files (no path traversal possible from the
 * URL — the :name parameter is keyed against this map). Each entry has
 * a stable URL slug, the absolute path, and a friendly label.
 *
 * Any read goes through `getLogTail(name, lines)`; an unknown name returns
 * null without touching the filesystem.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { STATE_DIR } from "../shared/paths.js";

const HOME = homedir();
const LOGS_DIR = resolve(HOME, "Library", "Logs");

export interface LogFile {
  name: string;        // slug used in URLs
  label: string;       // friendly name for the dashboard
  path: string;        // absolute path
}

/** Hard-coded allow-list. Add new entries here only. */
export const LOG_REGISTRY: ReadonlyArray<LogFile> = [
  { name: "bridge",       label: "Bridge",                    path: resolve(LOGS_DIR, "sherlock-bridge.log") },
  { name: "indexer",      label: "Indexer",                   path: resolve(LOGS_DIR, "sherlock-indexer.log") },
  { name: "admin",        label: "Admin",                     path: resolve(LOGS_DIR, "sherlock-admin.log") },
  { name: "context-sync", label: "Context git-sync",          path: resolve(LOGS_DIR, "sherlock-context-sync.log") },
  { name: "vault-sync",   label: "Vault git-sync",            path: resolve(LOGS_DIR, "sherlock-vault-sync.log") },
  { name: "mcp-context",  label: "MCP context.search",        path: resolve(STATE_DIR, "mcp-context-search.log") },
  { name: "mcp-research", label: "MCP research-control",      path: resolve(STATE_DIR, "mcp-research-control.log") },
  { name: "mcp-sources",  label: "MCP sources",               path: resolve(STATE_DIR, "mcp-sources.log") },
  { name: "mcp-report",   label: "MCP report-writer",         path: resolve(STATE_DIR, "mcp-report-writer.log") },
  { name: "mcp-bb",       label: "MCP bluebubbles",           path: resolve(STATE_DIR, "mcp-bluebubbles-out.log") },
];

const REGISTRY_BY_NAME = new Map<string, LogFile>(LOG_REGISTRY.map((l) => [l.name, l]));

export interface LogListEntry {
  name: string;
  label: string;
  path: string;
  exists: boolean;
  size?: number;
  modified_at?: number;
}

/** Status of every registered log file. */
export function listLogs(): LogListEntry[] {
  return LOG_REGISTRY.map((f) => {
    const out: LogListEntry = { name: f.name, label: f.label, path: f.path, exists: existsSync(f.path) };
    if (out.exists) {
      try {
        const st = statSync(f.path);
        out.size = st.size;
        out.modified_at = st.mtimeMs;
      } catch { /* ignore */ }
    }
    return out;
  });
}

export interface LogTail {
  name: string;
  label: string;
  path: string;
  exists: boolean;
  total_lines: number;
  shown_lines: number;
  text: string;
}

/** Tail of one log. Returns null if `name` is not in the registry. */
export function getLogTail(name: string, lines: number): LogTail | null {
  const f = REGISTRY_BY_NAME.get(name);
  if (!f) return null;
  if (!existsSync(f.path)) {
    return {
      name: f.name, label: f.label, path: f.path, exists: false,
      total_lines: 0, shown_lines: 0, text: "",
    };
  }
  let text = "";
  try { text = readFileSync(f.path, "utf-8"); }
  catch (err) {
    return {
      name: f.name, label: f.label, path: f.path, exists: true,
      total_lines: 0, shown_lines: 0,
      text: `error reading log: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const allLines = text.split("\n");
  // Drop a trailing empty line from a final \n so the count is honest.
  if (allLines.length > 0 && allLines[allLines.length - 1] === "") allLines.pop();
  const cap = Math.max(1, Math.min(lines, 5000));
  const tail = allLines.slice(-cap);
  return {
    name: f.name, label: f.label, path: f.path, exists: true,
    total_lines: allLines.length,
    shown_lines: tail.length,
    text: tail.join("\n"),
  };
}
