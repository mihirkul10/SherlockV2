/**
 * Cloud-friendly indexing CLI.
 *
 * Reads sherlock-context/_raw, computes a manifest diff against the shared
 * retrieval service, prepares only changed documents (chunking + embeddings),
 * and pushes them to the remote index over HTTP.
 */

import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { glob } from "node:fs/promises";
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { nanoid } from "nanoid";
import { buildPreparedDocument } from "../retrieval/build-document.js";
import {
  CONTEXT_RAW_DIR,
  CONTEXT_PATH,
  fromContextRelativePath,
  STATE_DIR,
  toContextRelativePath,
} from "../shared/paths.js";
import { createLogger } from "../shared/logger.js";
import { loadEnv, optionalEnv } from "../shared/env.js";
import type { PreparedDocument } from "../retrieval/contracts.js";
import {
  DeleteDocumentsRequestSchema,
  ManifestDiffResponseSchema,
  UpsertDocumentsRequestSchema,
} from "../retrieval/contracts.js";

loadEnv();
const log = createLogger("cloud-index-sync");
const LOCK_PATH = resolve(STATE_DIR, "cloud-index-sync.lock");

function apiBase(): string {
  const url = optionalEnv("SHERLOCK_CONTEXT_API_URL");
  if (!url) throw new Error("SHERLOCK_CONTEXT_API_URL is required for cloud indexing");
  return url.replace(/\/$/, "");
}

function authHeaders(): Record<string, string> {
  const token = optionalEnv("SHERLOCK_CONTEXT_API_TOKEN");
  return token ? { "Authorization": `Bearer ${token}` } : {};
}

function formatFetchError(err: unknown, context: string): string {
  if (!(err instanceof Error)) return `${context}: ${String(err)}`;
  const parts = [`${context}: ${err.message}`];
  const cause = (err as Error & { cause?: unknown }).cause;
  if (cause instanceof Error) {
    parts.push(`cause=${cause.message}`);
    const code = (cause as NodeJS.ErrnoException).code;
    if (code) parts.push(`code=${code}`);
  }
  return parts.join(" ");
}

async function postJson<T>(path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${apiBase()}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (err) {
    throw new Error(formatFetchError(err, `POST ${path}`));
  }
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`POST ${path} failed (${response.status}): ${text.slice(0, 300)}`);
  }
  return await response.json() as T;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock(): boolean {
  try {
    const fd = openSync(LOCK_PATH, "wx");
    writeSync(fd, String(process.pid));
    closeSync(fd);
    return true;
  } catch {
    if (!existsSync(LOCK_PATH)) return false;
    const raw = readFileSync(LOCK_PATH, "utf-8").trim();
    const pid = Number.parseInt(raw, 10);
    if (!Number.isNaN(pid) && !processAlive(pid)) {
      unlinkSync(LOCK_PATH);
      return acquireLock();
    }
    return false;
  }
}

function releaseLock(): void {
  try {
    if (!existsSync(LOCK_PATH)) return;
    // Only delete a lock we own — an unconditional unlink lets an exiting run
    // strip the protection of a concurrently running one.
    const raw = readFileSync(LOCK_PATH, "utf-8").trim();
    if (raw === String(process.pid)) unlinkSync(LOCK_PATH);
  } catch {
    // best-effort
  }
}

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function currentContextRevision(): string | undefined {
  try {
    return execSync("git rev-parse HEAD", {
      cwd: CONTEXT_PATH,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf-8",
    }).trim();
  } catch {
    return undefined;
  }
}

async function loadManifest(): Promise<Array<{ path: string; raw_sha256: string }>> {
  const manifest: Array<{ path: string; raw_sha256: string }> = [];
  for await (const file of glob(`${CONTEXT_RAW_DIR}/**/*.md`)) {
    manifest.push({
      path: toContextRelativePath(file),
      raw_sha256: sha(readFileSync(file, "utf-8")),
    });
  }
  manifest.sort((a, b) => a.path.localeCompare(b.path));
  return manifest;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function postBatchWithRetry(documents: PreparedDocument[], attempts = 3): Promise<{ changed_chunks?: number }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const payload = UpsertDocumentsRequestSchema.parse({ documents });
      return await postJson<{ changed_chunks?: number }>("/admin/upsert-docs", payload);
    } catch (err) {
      lastError = err;
      if (attempt < attempts) await sleep(500 * attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function buildWithRetry(relPath: string, attempts = 3): Promise<PreparedDocument | null> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await buildPreparedDocument(fromContextRelativePath(relPath));
    } catch (err) {
      lastError = err;
      if (attempt < attempts) await sleep(1000 * attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function buildAndUpsert(paths: string[], batchSize: number): Promise<{ changedDocs: number; changedChunks: number }> {
  // Each document build makes one Voyage embeddings call — that's the slow
  // part, so build a few documents concurrently while keeping uploads batched.
  const buildConcurrency = Math.max(1, parseInt(process.env["SHERLOCK_CONTEXT_BUILD_CONCURRENCY"] ?? "6", 10));
  let changedDocs = 0;
  let changedChunks = 0;
  let pending: PreparedDocument[] = [];

  const flush = async (): Promise<void> => {
    if (pending.length === 0) return;
    const response = await postBatchWithRetry(pending);
    changedDocs += pending.length;
    changedChunks += response.changed_chunks ?? 0;
    pending = [];
  };

  let lastLogged = 0;
  for (let i = 0; i < paths.length; i += buildConcurrency) {
    const group = paths.slice(i, i + buildConcurrency);
    const documents = await Promise.all(group.map((relPath) => buildWithRetry(relPath)));
    for (const document of documents) {
      if (!document) continue;
      pending.push(document);
      if (pending.length >= batchSize) await flush();
    }
    const built = Math.min(i + buildConcurrency, paths.length);
    if (built - lastLogged >= 25 || built === paths.length) {
      lastLogged = built;
      log.info({ built, total: paths.length, changedDocs, changedChunks }, "cloud index sync progress");
    }
  }
  await flush();
  return { changedDocs, changedChunks };
}

async function main(): Promise<number> {
  if (!acquireLock()) {
    log.info("another cloud index sync is already running; skipping");
    return 0;
  }

  const startedAt = new Date().toISOString();
  const runId = `cloud-index-${nanoid(8)}`;
  const errors: string[] = [];
  let changedDocs = 0;
  let changedChunks = 0;
  let deletedDocs = 0;
  const batchSize = Math.max(1, parseInt(process.env["SHERLOCK_CONTEXT_UPSERT_BATCH_SIZE"] ?? "1", 10));

  try {
    const manifest = await loadManifest();
    if (manifest.length === 0) {
      throw new Error("local manifest is empty — refusing to sync (is sherlock-context/_raw present in this environment?)");
    }
    const diff = ManifestDiffResponseSchema.parse(await postJson("/admin/manifest-diff", { manifest }));
    log.info({ manifest: manifest.length, upsert: diff.upsert_paths.length, delete: diff.delete_paths.length }, "remote manifest diff");

    if (diff.upsert_paths.length > 0) {
      const result = await buildAndUpsert(diff.upsert_paths, batchSize);
      changedDocs = result.changedDocs;
      changedChunks = result.changedChunks;
    }
    // Mass-delete guardrail: a sync running against a partial or stale copy of
    // sherlock-context (e.g. a cloud sandbox whose clone failed) sees a tiny
    // manifest and would otherwise instruct the server to delete most of the
    // corpus. Refuse unless explicitly overridden.
    const deleteCap = Math.max(25, Math.floor(manifest.length * 0.1));
    if (diff.delete_paths.length > deleteCap && process.env["SHERLOCK_INDEX_ALLOW_MASS_DELETE"] !== "1") {
      errors.push(
        `refusing to delete ${diff.delete_paths.length} docs (cap ${deleteCap} for a ${manifest.length}-doc manifest); ` +
        `set SHERLOCK_INDEX_ALLOW_MASS_DELETE=1 if this is intentional`,
      );
    } else if (diff.delete_paths.length > 0) {
      const payload = DeleteDocumentsRequestSchema.parse({ paths: diff.delete_paths });
      const response = await postJson<{ deleted_docs?: number }>("/admin/delete-docs", payload);
      deletedDocs = response.deleted_docs ?? 0;
    }
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  } finally {
    releaseLock();
  }

  const status = errors.length === 0 ? "ok" : (changedDocs > 0 || deletedDocs > 0 ? "partial" : "error");
  try {
    await postJson("/admin/index-runs", {
      run_id: runId,
      source: "cloud-indexer",
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      status,
      changed_docs: changedDocs,
      changed_chunks: changedChunks,
      deleted_docs: deletedDocs,
      errors,
      context_revision: currentContextRevision(),
    });
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, "failed to record index run");
  }

  if (errors.length > 0) {
    log.error({ errors, changedDocs, changedChunks, deletedDocs }, "cloud index sync completed with errors");
    return status === "partial" ? 0 : 1;
  }

  log.info({ changedDocs, changedChunks, deletedDocs }, "cloud index sync complete");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    releaseLock();
    log.fatal({ err: err instanceof Error ? err.message : String(err) }, "cloud index sync crashed");
    process.exit(1);
  });
