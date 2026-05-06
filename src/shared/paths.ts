import { resolve } from "node:path";
import { homedir } from "node:os";

const HOME = homedir();

export const PROJECT_ROOT =
  process.env["SHERLOCK_PROJECT_ROOT"] ?? resolve(HOME, "Projects", "SherlockV2");

export const CONTEXT_PATH =
  process.env["SHERLOCK_CONTEXT_PATH"] ?? resolve(HOME, "Projects", "sherlock-context");

export const VAULT_PATH =
  process.env["SHERLOCK_VAULT_PATH"] ?? resolve(HOME, "Projects", "sherlock-vault");

export const ENV_PATH = resolve(HOME, ".sherlock", ".env");

export const STATE_DIR = resolve(PROJECT_ROOT, "state");
export const INDEX_DB = resolve(STATE_DIR, "index.sqlite");
export const SHARED_INDEX_DB =
  process.env["SHERLOCK_SHARED_INDEX_DB"] ?? resolve(STATE_DIR, "shared-index.sqlite");
export const CONVERSATIONS_DB = resolve(STATE_DIR, "conversations.sqlite");
export const RESEARCH_RUNS_DB = resolve(STATE_DIR, "research-runs.sqlite");
export const CLOUD_RUNS_DB = resolve(STATE_DIR, "cloud-runs.sqlite");

export const CONTEXT_STATE_DIR = resolve(CONTEXT_PATH, "_state");
export const CONTEXT_RAW_DIR = resolve(CONTEXT_PATH, "_raw");
export const CONTEXT_RUNS_LOG = resolve(CONTEXT_PATH, "_runs", "ingest-runs.ndjson");
export const SOURCES_JSON = resolve(CONTEXT_STATE_DIR, "sources.json");

export const VAULT_REPORTS_DIR = resolve(VAULT_PATH, "Reports");
export const VAULT_REPORTS_INDEX = resolve(VAULT_REPORTS_DIR, "_index.md");

export function stateFilePath(source: string): string {
  return resolve(CONTEXT_STATE_DIR, `${source}-state.json`);
}

export function rawDir(source: string, slug: string): string {
  return resolve(CONTEXT_RAW_DIR, source, slug);
}
