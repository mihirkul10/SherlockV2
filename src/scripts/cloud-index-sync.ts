/**
 * Cloud-friendly indexing CLI.
 *
 * Reads sherlock-context/_raw, computes a manifest diff against the shared
 * retrieval service, prepares only changed documents (chunking + embeddings),
 * and pushes them to the remote index over HTTP.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { glob } from "node:fs/promises";
import { execSync } from "node:child_process";
import { nanoid } from "nanoid";
import { buildPreparedDocument } from "../retrieval/build-document.js";
import { CONTEXT_RAW_DIR, CONTEXT_PATH, fromContextRelativePath, toContextRelativePath } from "../shared/paths.js";
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

function apiBase(): string {
  const url = optionalEnv("SHERLOCK_CONTEXT_API_URL");
  if (!url) throw new Error("SHERLOCK_CONTEXT_API_URL is required for cloud indexing");
  return url.replace(/\/$/, "");
}

function authHeaders(): Record<string, string> {
  const token = optionalEnv("SHERLOCK_CONTEXT_API_TOKEN");
  return token ? { "Authorization": `Bearer ${token}` } : {};
}

async function postJson<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${apiBase()}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`POST ${path} failed (${response.status}): ${text.slice(0, 300)}`);
  }
  return await response.json() as T;
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

async function buildDocuments(paths: string[]): Promise<PreparedDocument[]> {
  const docs: PreparedDocument[] = [];
  for (const path of paths) {
    const document = await buildPreparedDocument(fromContextRelativePath(path));
    if (document) docs.push(document);
  }
  return docs;
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
      const errorMsg = err instanceof Error ? err.message : String(err);
      
      if (errorMsg.includes("UNIQUE constraint failed: documents.path")) {
        if (documents.length > 1) {
          log.warn({ count: documents.length }, "UNIQUE constraint on path; retrying documents individually");
          let changedChunks = 0;
          for (const doc of documents) {
            try {
              const result = await postBatchWithRetry([doc], 1);
              changedChunks += result.changed_chunks ?? 0;
            } catch (docErr) {
              log.warn({ path: doc.path }, "failed to upsert document; continuing with others");
            }
          }
          return { changed_chunks: changedChunks };
        }
        log.warn({ path: documents[0]?.path }, "UNIQUE constraint on single document; attempting delete-then-insert");
        
        if (documents[0]) {
          try {
            await postJson("/admin/delete-docs", { paths: [documents[0].path] });
            log.info({ path: documents[0].path }, "deleted existing document; retrying insert");
            const payload = UpsertDocumentsRequestSchema.parse({ documents });
            return await postJson<{ changed_chunks?: number }>("/admin/upsert-docs", payload);
          } catch (deleteErr) {
            log.warn({ path: documents[0]?.path }, "delete-then-insert also failed; giving up on this document");
            return { changed_chunks: 0 };
          }
        }
      }
      
      if (attempt < attempts) await sleep(500 * attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function upsertInBatches(documents: PreparedDocument[], batchSize = 1): Promise<number> {
  let changedChunks = 0;
  for (let i = 0; i < documents.length; i += batchSize) {
    const batch = documents.slice(i, i + batchSize);
    try {
      const response = await postBatchWithRetry(batch);
      changedChunks += response.changed_chunks ?? 0;
    } catch (err) {
      log.warn({ count: batch.length }, "batch upsert failed; continuing with next batch");
    }
  }
  return changedChunks;
}

async function main(): Promise<number> {
  const startedAt = new Date().toISOString();
  const runId = `cloud-index-${nanoid(8)}`;
  const errors: string[] = [];
  let changedDocs = 0;
  let changedChunks = 0;
  let deletedDocs = 0;
  const batchSize = Math.max(1, parseInt(process.env["SHERLOCK_CONTEXT_UPSERT_BATCH_SIZE"] ?? "1", 10));

  try {
    const manifest = await loadManifest();
    const diff = ManifestDiffResponseSchema.parse(await postJson("/admin/manifest-diff", { manifest }));
    log.info({ manifest: manifest.length, upsert: diff.upsert_paths.length, delete: diff.delete_paths.length }, "remote manifest diff");

    if (diff.upsert_paths.length > 0) {
      const documents = await buildDocuments(diff.upsert_paths);
      changedDocs = documents.length;
      changedChunks = await upsertInBatches(documents, batchSize);
    }
    if (diff.delete_paths.length > 0) {
      const payload = DeleteDocumentsRequestSchema.parse({ paths: diff.delete_paths });
      const response = await postJson<{ deleted_docs?: number }>("/admin/delete-docs", payload);
      deletedDocs = response.deleted_docs ?? 0;
    }
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  const status = errors.length === 0 ? "ok" : (changedDocs > 0 || deletedDocs > 0 ? "partial" : "error");
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
    log.fatal({ err: err instanceof Error ? err.message : String(err) }, "cloud index sync crashed");
    process.exit(1);
  });
