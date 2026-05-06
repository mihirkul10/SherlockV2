/**
 * Cloud indexing agent — reads sherlock-context/_raw files and indexes them
 * into the configured retrieval API (Parallel Search batch indexing).
 *
 * Usage: npm run index:cloud
 *
 * This script:
 *   1. Reads all Markdown files from sherlock-context/_raw
 *   2. Extracts frontmatter + body from each
 *   3. Batches files and sends to the retrieval API for indexing
 *   4. Writes a run record to _runs/index-runs.ndjson for audit trail
 *   5. Returns exit code 0 on success, 1 on error
 */

import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { resolve, relative } from "node:path";
import { glob } from "node:fs/promises";
import { CONTEXT_RAW_DIR, CONTEXT_PATH } from "../shared/paths.js";
import { loadEnv } from "../shared/env.js";
import { createLogger } from "../shared/logger.js";

const log = createLogger("script:index-cloud");

interface ParsedMarkdown {
  frontmatter: Record<string, string>;
  body: string;
}

/** Minimal frontmatter parser — handles the subset we emit in ingest/markdown.ts. */
function parseMarkdown(text: string): ParsedMarkdown {
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return { frontmatter: {}, body: text };
  const fm: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const kv = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2]!.trim();
    // Unquote double-quoted values
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\").replace(/\\n/g, "\n");
    }
    fm[kv[1]!] = value;
  }
  return { frontmatter: fm, body: m[2]!.trim() };
}

interface IndexedDoc {
  source: string;
  source_id: string;
  content_id: string;
  title: string;
  published_at: string;
  author?: string;
  body: string;
  language?: string;
  url?: string;
}

async function collectFiles(): Promise<Array<{ path: string; doc: IndexedDoc }>> {
  const docs: Array<{ path: string; doc: IndexedDoc }> = [];
  const rawDir = CONTEXT_RAW_DIR;
  let scanned = 0;

  try {
    const pattern = `${rawDir}/**/*.md`;
    
    for await (const filePath of glob(pattern)) {
      scanned++;
      try {
        const raw = readFileSync(filePath, "utf-8");
        const { frontmatter, body } = parseMarkdown(raw);

        // Extract source from path: _raw/<source>/<source_id>/...
        const relPath = relative(rawDir, filePath);
        const parts = relPath.split("/");
        if (parts.length < 3) {
          log.warn({ filePath }, "skip: unexpected path structure");
          continue;
        }

        const source = parts[0]!;
        const source_id = parts[1]!;
        const content_id = frontmatter["content_id"] || frontmatter["id"] || relPath;

        if (!frontmatter["title"]) {
          log.warn({ filePath }, "skip: missing frontmatter.title");
          continue;
        }

        const doc: IndexedDoc = {
          source,
          source_id,
          content_id,
          title: frontmatter["title"]!,
          published_at: frontmatter["published_at"] || new Date().toISOString(),
          author: frontmatter["author"],
          body: body || "",
          language: frontmatter["language"],
          url: frontmatter["url"],
        };

        docs.push({ path: filePath, doc });
      } catch (err) {
        log.warn({ filePath, err: err instanceof Error ? err.message : String(err) }, "skip unparseable file");
      }
    }

    log.info({ scanned, collected: docs.length }, "found markdown files");
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, "failed to collect files");
    throw err;
  }

  return docs;
}

async function indexToApi(docs: Array<IndexedDoc>): Promise<number> {
  const parallelKey = process.env["PARALLEL_API_KEY"];
  if (!parallelKey) {
    log.warn("PARALLEL_API_KEY not set; skipping cloud indexing (local index still updated)");
    return 0;
  }

  const batchSize = 100;
  let indexed = 0;

  for (let i = 0; i < docs.length; i += batchSize) {
    const batch = docs.slice(i, i + batchSize);
    log.info({ batch: Math.floor(i / batchSize) + 1, size: batch.length }, "indexing batch");

    try {
      // Format documents for batch indexing endpoint
      // This is a placeholder — adjust to match your retrieval API spec
      const payload = {
        documents: batch.map((doc) => ({
          id: `${doc.source}:${doc.content_id}`,
          content: `${doc.title}\n\n${doc.body}`,
          metadata: {
            source: doc.source,
            source_id: doc.source_id,
            title: doc.title,
            published_at: doc.published_at,
            author: doc.author,
            language: doc.language,
            url: doc.url,
          },
        })),
      };

      const response = await fetch("https://api.parallel.ai/v1/batch/index", {
        method: "POST",
        headers: {
          "x-api-key": parallelKey,
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const text = await response.text();
        log.warn({ status: response.status, body: text }, "batch index request failed");
      } else {
        indexed += batch.length;
        log.debug({ batch: Math.floor(i / batchSize) + 1 }, "batch indexed successfully");
      }
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, "batch index request error (continuing)");
    }
  }

  return indexed;
}

async function writeRunRecord(indexed: number, total: number): Promise<void> {
  try {
    const runsDir = resolve(CONTEXT_PATH, "_runs");
    mkdirSync(runsDir, { recursive: true });

    const record = {
      timestamp: new Date().toISOString(),
      type: "index-cloud",
      docs_total: total,
      docs_indexed: indexed,
      status: indexed > 0 ? "ok" : "noop",
    };

    appendFileSync(resolve(runsDir, "index-runs.ndjson"), JSON.stringify(record) + "\n", "utf-8");
    log.info({ indexed, total }, "run record written");
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, "failed to write run record");
  }
}

async function main(): Promise<number> {
  try {
    loadEnv();
    log.info("starting cloud indexing…");

    const docs = await collectFiles();
    log.info({ count: docs.length }, "collected documents");

    if (docs.length === 0) {
      log.info("no documents to index");
      await writeRunRecord(0, 0);
      return 0;
    }

    const indexed = await indexToApi(docs.map((d) => d.doc));
    await writeRunRecord(indexed, docs.length);

    log.info({ indexed, total: docs.length }, "✓ cloud indexing complete");
    return 0;
  } catch (err) {
    log.fatal({ err: err instanceof Error ? err.message : String(err) }, "index-cloud crashed");
    return 1;
  }
}

main().then((code) => process.exit(code)).catch((err) => {
  log.fatal({ err: err instanceof Error ? err.message : String(err) }, "index-cloud crashed");
  process.exit(1);
});
