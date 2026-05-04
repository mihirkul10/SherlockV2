/**
 * Bulk-load every Markdown file under sherlock-context/_raw into the local
 * SQLite FTS5 index. Idempotent — re-runnable; per-doc upserts keyed by
 * (source, content_id).
 *
 * Used by:
 *   - The reindex CLI (`npm run reindex`) for cold rebuilds.
 *   - The watcher's startup scan to fill the index from disk before going
 *     into incremental mode.
 */

import { readFileSync } from "node:fs";
import { CONTEXT_RAW_DIR } from "../shared/paths.js";
import { upsertDoc, type IndexedDoc, getStats } from "./sqlite-fts.js";
import { createLogger } from "../shared/logger.js";
import { glob } from "node:fs/promises";

const log = createLogger("index:loader");

interface ParsedMarkdown {
  frontmatter: Record<string, string>;
  body: string;
}

/** Minimal frontmatter parser — handles the subset we emit in ingest/markdown.ts. */
export function parseMarkdown(text: string): ParsedMarkdown {
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

export function indexFile(path: string): IndexedDoc | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    log.warn({ path, err: err instanceof Error ? err.message : String(err) }, "skip unreadable file");
    return null;
  }
  const { frontmatter, body } = parseMarkdown(raw);
  if (!frontmatter["source"] || !frontmatter["content_id"]) {
    log.debug({ path }, "skip non-conforming markdown");
    return null;
  }
  const doc: IndexedDoc = {
    source: frontmatter["source"]!,
    source_id: frontmatter["source_id"] ?? "",
    content_id: frontmatter["content_id"]!,
    title: frontmatter["title"] ?? path,
    body,
    path,
    ...(frontmatter["url"] && { url: frontmatter["url"] }),
    ...(frontmatter["author"] && { author: frontmatter["author"] }),
    ...(frontmatter["published_at"] && { published_at: frontmatter["published_at"] }),
    ...(frontmatter["ingested_at"] && { ingested_at: frontmatter["ingested_at"] }),
    ...(frontmatter["transcript_status"] && { transcript_status: frontmatter["transcript_status"] }),
    ...(frontmatter["language"] && { language: frontmatter["language"] }),
  };
  upsertDoc(doc);
  return doc;
}

export async function reindexAll(): Promise<{ scanned: number; indexed: number }> {
  let scanned = 0;
  let indexed = 0;
  // glob.async iterator (Node 22+)
  for await (const file of glob(`${CONTEXT_RAW_DIR}/**/*.md`)) {
    scanned++;
    const doc = indexFile(file);
    if (doc) indexed++;
  }
  log.info({ scanned, indexed, ...getStats() }, "✓ reindex complete");
  return { scanned, indexed };
}
