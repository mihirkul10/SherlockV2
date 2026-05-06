/**
 * Corpus file explorer.
 *
 * Reads the preferred corpus DB (`state/shared-index.sqlite` when present,
 * otherwise the legacy `state/index.sqlite`). Lets the dashboard browse all
 * indexed docs by source and open the raw markdown for any single doc.
 *
 * Read-only. The doc body is read live from the `path` column on disk —
 * we don't trust the FTS-indexed copy because the markdown is the source
 * of truth.
 */

import Database from "better-sqlite3";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { INDEX_DB, SHARED_INDEX_DB, CONTEXT_PATH } from "../shared/paths.js";

export interface CorpusDocSummary {
  doc_id: number;
  source: string;
  source_id: string;
  content_id: string;
  url?: string;
  author?: string;
  title?: string;
  published_at?: string;
  ingested_at?: string;
  transcript_status?: string;
  language?: string;
  body_chars?: number;
  /** Path relative to sherlock-context/ for cleaner display. */
  rel_path: string;
}

export interface CorpusList {
  generated_at: string;
  total: number;            // matches across the current filter
  total_all: number;        // total in corpus regardless of filter
  by_source: Record<string, number>;
  authors: Array<{ author: string; n: number }>;
  docs: CorpusDocSummary[];
  filters: {
    source?: string;
    author?: string;
    q?: string;
    limit: number;
    offset: number;
  };
}

export interface CorpusDoc extends CorpusDocSummary {
  /** Absolute path to the markdown file. */
  abs_path: string;
  /** Raw markdown body (frontmatter included). */
  body: string;
  /** Size on disk in bytes. */
  size_bytes: number;
}

function relPath(p: string): string {
  if (p.startsWith(CONTEXT_PATH + "/")) return p.slice(CONTEXT_PATH.length + 1);
  return p;
}

function preferredCorpusDbPath(): string {
  return existsSync(SHARED_INDEX_DB) ? SHARED_INDEX_DB : INDEX_DB;
}

function rowToSummary(r: Record<string, unknown>): CorpusDocSummary {
  const out: CorpusDocSummary = {
    doc_id: r["doc_id"] as number,
    source: r["source"] as string,
    source_id: r["source_id"] as string,
    content_id: r["content_id"] as string,
    rel_path: relPath(r["path"] as string),
  };
  if (r["url"]) out.url = r["url"] as string;
  if (r["author"]) out.author = r["author"] as string;
  if (r["title"]) out.title = r["title"] as string;
  if (r["published_at"]) out.published_at = r["published_at"] as string;
  if (r["ingested_at"]) out.ingested_at = r["ingested_at"] as string;
  if (r["transcript_status"]) out.transcript_status = r["transcript_status"] as string;
  if (r["language"]) out.language = r["language"] as string;
  if (typeof r["body_chars"] === "number") out.body_chars = r["body_chars"] as number;
  return out;
}

/**
 * Browse the corpus. Filters are AND-ed. `q` does an FTS5 MATCH against
 * title+body when present (defensive: gracefully degrades to a LIKE on
 * title if the FTS query is malformed).
 */
export function listDocs(opts: {
  source?: string;
  author?: string;
  q?: string;
  limit?: number;
  offset?: number;
}): CorpusList {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
  const offset = Math.max(0, opts.offset ?? 0);
  const filters: CorpusList["filters"] = { limit, offset };
  if (opts.source) filters.source = opts.source;
  if (opts.author) filters.author = opts.author;
  if (opts.q) filters.q = opts.q;

  const empty: CorpusList = {
    generated_at: new Date().toISOString(),
    total: 0, total_all: 0,
    by_source: {}, authors: [], docs: [],
    filters,
  };
  const dbPath = preferredCorpusDbPath();
  if (!existsSync(dbPath)) return empty;

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const docsTable = dbPath === SHARED_INDEX_DB ? "documents" : "docs";
    const totalAllRow = db.prepare(`SELECT COUNT(*) n FROM ${docsTable}`).get() as { n: number };
    const totalAll = totalAllRow.n;
    const bySource = (db.prepare(`SELECT source, COUNT(*) n FROM ${docsTable} GROUP BY source`).all() as Array<{ source: string; n: number }>);
    const authors = (db.prepare(
      `SELECT author, COUNT(*) n FROM ${docsTable} WHERE author IS NOT NULL AND author != '' GROUP BY author ORDER BY n DESC, author ASC LIMIT 100`
    ).all() as Array<{ author: string; n: number }>);

    // Build the WHERE clause incrementally.
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.source) { where.push("d.source = ?"); params.push(opts.source); }
    if (opts.author) { where.push("d.author = ?"); params.push(opts.author); }

    let baseFrom = `FROM ${docsTable} d`;
    let qDocIds: number[] | null = null;
    if (opts.q && opts.q.trim()) {
      if (dbPath === SHARED_INDEX_DB) {
        where.push("(d.title LIKE ? OR d.content_id LIKE ?)");
        params.push(`%${opts.q}%`, `%${opts.q}%`);
      } else {
        // FTS5 MATCH; safely escape the user's term for FTS5 syntax (wrap in quotes).
        const escaped = opts.q.replace(/"/g, '""');
        try {
          const rows = db.prepare(
            `SELECT rowid FROM docs_fts WHERE docs_fts MATCH ? LIMIT 2000`
          ).all(`"${escaped}"`) as Array<{ rowid: number }>;
          qDocIds = rows.map((r) => r.rowid);
          if (qDocIds.length === 0) {
            return { ...empty, total_all: totalAll, by_source: Object.fromEntries(bySource.map(r => [r.source, r.n])), authors };
          }
        } catch {
          // Fallback: title LIKE.
          where.push("d.title LIKE ?");
          params.push(`%${opts.q}%`);
        }
      }
    }
    if (qDocIds && qDocIds.length > 0) {
      where.push(`d.doc_id IN (${qDocIds.map(() => "?").join(",")})`);
      params.push(...qDocIds);
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

    const totalRow = db.prepare(`SELECT COUNT(*) n ${baseFrom} ${whereSql}`).get(...params) as { n: number };
    const total = totalRow.n;

    const rows = db.prepare(
      `SELECT d.doc_id, d.source, d.source_id, d.content_id, d.url, d.author, d.title,
              d.published_at, d.ingested_at, d.transcript_status, d.language, d.body_chars, d.path
       ${baseFrom}
       ${whereSql}
       ORDER BY COALESCE(d.published_at, d.ingested_at) DESC
       LIMIT ? OFFSET ?`
    ).all(...params, limit, offset) as Array<Record<string, unknown>>;

    return {
      generated_at: new Date().toISOString(),
      total, total_all: totalAll,
      by_source: Object.fromEntries(bySource.map((r) => [r.source, r.n])),
      authors,
      docs: rows.map(rowToSummary),
      filters,
    };
  } finally { db.close(); }
}

/** Fetch one doc + its raw markdown body. Returns null if unknown. */
export function getDoc(docId: number): CorpusDoc | null {
  const dbPath = preferredCorpusDbPath();
  if (!existsSync(dbPath)) return null;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const docsTable = dbPath === SHARED_INDEX_DB ? "documents" : "docs";
    const row = db.prepare(
      `SELECT doc_id, source, source_id, content_id, url, author, title,
              published_at, ingested_at, transcript_status, language, body_chars, path
       FROM ${docsTable} WHERE doc_id = ?`
    ).get(docId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const summary = rowToSummary(row);
    const absPath = row["path"] as string;
    let body = "";
    let size = 0;
    if (existsSync(absPath)) {
      try { body = readFileSync(absPath, "utf-8"); }
      catch (err) { body = `(error reading file: ${err instanceof Error ? err.message : String(err)})`; }
      try { size = statSync(absPath).size; } catch { /* ignore */ }
    } else {
      body = `(file missing on disk: ${absPath})`;
    }
    return { ...summary, abs_path: absPath, body, size_bytes: size };
  } finally { db.close(); }
}

/** Resolve a path inside CONTEXT_PATH safely (no traversal escape). */
export function safeContextPath(rel: string): string | null {
  const resolved = resolve(CONTEXT_PATH, rel);
  if (!resolved.startsWith(CONTEXT_PATH + "/")) return null;
  return resolved;
}
