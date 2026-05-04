/**
 * Local SQLite FTS5 index over the sherlock-context corpus.
 *
 * Schema:
 *   docs        — physical table, one row per ingested Markdown file.
 *                  Holds frontmatter columns + path on disk.
 *   docs_fts    — FTS5 virtual table over title + body for fast text search.
 *
 * Upsert is keyed by (source, content_id) — re-ingesting an item replaces
 * the row in place. Path tracked separately so we can delete by path on
 * file removal events from the chokidar watcher.
 */

import Database, { type Database as DB } from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { INDEX_DB } from "../shared/paths.js";
import { createLogger } from "../shared/logger.js";

const log = createLogger("index:sqlite-fts");

let db: DB | null = null;

export function getIndexDb(): DB {
  if (db) return db;
  mkdirSync(dirname(INDEX_DB), { recursive: true });
  db = new Database(INDEX_DB);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS docs (
      doc_id            INTEGER PRIMARY KEY AUTOINCREMENT,
      source            TEXT NOT NULL,
      source_id         TEXT NOT NULL,
      content_id        TEXT NOT NULL,
      url               TEXT,
      author            TEXT,
      title             TEXT,
      published_at      TEXT,
      ingested_at       TEXT,
      transcript_status TEXT,
      language          TEXT,
      path              TEXT NOT NULL UNIQUE,
      body_chars        INTEGER,
      UNIQUE(source, content_id)
    );

    CREATE INDEX IF NOT EXISTS idx_docs_source        ON docs(source);
    CREATE INDEX IF NOT EXISTS idx_docs_source_id     ON docs(source, source_id);
    CREATE INDEX IF NOT EXISTS idx_docs_published_at  ON docs(published_at);
    CREATE INDEX IF NOT EXISTS idx_docs_path          ON docs(path);

    -- NOTE: Not using content='' (contentless mode) because we want snippet()
    -- to return real excerpts. The 2x storage is fine at this scale.
    CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
      title,
      body,
      tokenize='porter unicode61 remove_diacritics 2'
    );
  `);
  log.info({ path: INDEX_DB }, "index db opened");
  return db;
}

export function closeIndexDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// ─── Upsert / delete ──────────────────────────────────────────────────

export interface IndexedDoc {
  source: string;
  source_id: string;
  content_id: string;
  url?: string;
  author?: string;
  title: string;
  published_at?: string;
  ingested_at?: string;
  transcript_status?: string;
  language?: string;
  path: string;
  body: string;
}

export function upsertDoc(doc: IndexedDoc): void {
  const d = getIndexDb();
  const tx = d.transaction((doc: IndexedDoc) => {
    // 1. Upsert the metadata row, returning the rowid we'll use for FTS.
    d.prepare(`
      INSERT INTO docs (source, source_id, content_id, url, author, title, published_at, ingested_at, transcript_status, language, path, body_chars)
      VALUES (@source, @source_id, @content_id, @url, @author, @title, @published_at, @ingested_at, @transcript_status, @language, @path, @body_chars)
      ON CONFLICT(source, content_id) DO UPDATE SET
        url=excluded.url,
        author=excluded.author,
        title=excluded.title,
        published_at=excluded.published_at,
        ingested_at=excluded.ingested_at,
        transcript_status=excluded.transcript_status,
        language=excluded.language,
        path=excluded.path,
        body_chars=excluded.body_chars
    `).run({
      source: doc.source,
      source_id: doc.source_id,
      content_id: doc.content_id,
      url: doc.url ?? null,
      author: doc.author ?? null,
      title: doc.title,
      published_at: doc.published_at ?? null,
      ingested_at: doc.ingested_at ?? null,
      transcript_status: doc.transcript_status ?? null,
      language: doc.language ?? null,
      path: doc.path,
      body_chars: doc.body.length,
    });

    const row = d.prepare(`SELECT doc_id FROM docs WHERE source=? AND content_id=?`)
      .get(doc.source, doc.content_id) as { doc_id: number } | undefined;
    if (!row) throw new Error(`doc upsert lost: ${doc.source}/${doc.content_id}`);
    const rowid = row.doc_id;

    // 2. Replace the FTS row with the same rowid.
    d.prepare(`DELETE FROM docs_fts WHERE rowid=?`).run(rowid);
    d.prepare(`INSERT INTO docs_fts (rowid, title, body) VALUES (?, ?, ?)`)
      .run(rowid, doc.title, doc.body);
  });
  tx(doc);
}

export function deleteByPath(path: string): boolean {
  const d = getIndexDb();
  const tx = d.transaction((p: string) => {
    const row = d.prepare(`SELECT doc_id FROM docs WHERE path=?`).get(p) as { doc_id: number } | undefined;
    if (!row) return false;
    d.prepare(`DELETE FROM docs_fts WHERE rowid=?`).run(row.doc_id);
    d.prepare(`DELETE FROM docs WHERE doc_id=?`).run(row.doc_id);
    return true;
  });
  return tx(path) as boolean;
}

// ─── Search ───────────────────────────────────────────────────────────

export interface SearchFilters {
  sources?: string[];          // ["youtube", "substack", ...]
  source_ids?: string[];       // specific channel/handle ids
  authors?: string[];
  since?: string;              // ISO date inclusive
  until?: string;              // ISO date inclusive
  language?: string;
}

export interface SearchHit {
  doc_id: number;
  source: string;
  source_id: string;
  content_id: string;
  url: string | null;
  author: string | null;
  title: string;
  published_at: string | null;
  path: string;
  snippet: string;             // 240-char excerpt with **highlights**
  rank: number;                // FTS5 bm25 score (lower = better)
}

/** Escape a user-provided query for FTS5 MATCH. We split on whitespace and
 * quote each token so that punctuation in the query doesn't break the parse.
 * Anyone who wants advanced FTS syntax can wrap their input in quotes. */
function buildFtsQuery(q: string): string {
  const tokens = q
    .toLowerCase()
    .replace(/[^a-z0-9\s'"-]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 20);
  if (tokens.length === 0) return '""';
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" ");
}

export function search(
  query: string,
  filters: SearchFilters = {},
  limit = 20,
): SearchHit[] {
  const d = getIndexDb();
  const ftsQ = buildFtsQuery(query);

  const where: string[] = [];
  const params: Record<string, unknown> = { fts: ftsQ };

  if (filters.sources?.length) {
    where.push(`d.source IN (${filters.sources.map((_, i) => `@s${i}`).join(",")})`);
    filters.sources.forEach((s, i) => { params[`s${i}`] = s; });
  }
  if (filters.source_ids?.length) {
    where.push(`d.source_id IN (${filters.source_ids.map((_, i) => `@sid${i}`).join(",")})`);
    filters.source_ids.forEach((s, i) => { params[`sid${i}`] = s; });
  }
  if (filters.authors?.length) {
    where.push(`d.author IN (${filters.authors.map((_, i) => `@a${i}`).join(",")})`);
    filters.authors.forEach((a, i) => { params[`a${i}`] = a; });
  }
  if (filters.since) {
    where.push(`d.published_at >= @since`);
    params["since"] = filters.since;
  }
  if (filters.until) {
    where.push(`d.published_at <= @until`);
    params["until"] = filters.until;
  }
  if (filters.language) {
    where.push(`d.language = @lang`);
    params["lang"] = filters.language;
  }
  const whereSql = where.length ? `AND ${where.join(" AND ")}` : "";

  const sql = `
    SELECT
      d.doc_id, d.source, d.source_id, d.content_id, d.url, d.author,
      d.title, d.published_at, d.path,
      snippet(docs_fts, 1, '**', '**', '…', 32) AS snippet,
      bm25(docs_fts) AS rank
    FROM docs_fts
    JOIN docs d ON d.doc_id = docs_fts.rowid
    WHERE docs_fts MATCH @fts
    ${whereSql}
    ORDER BY rank
    LIMIT @limit
  `;
  params["limit"] = limit;
  return d.prepare(sql).all(params) as SearchHit[];
}

export function getStats(): { total: number; bySource: Record<string, number> } {
  const d = getIndexDb();
  const total = (d.prepare(`SELECT COUNT(*) as n FROM docs`).get() as { n: number }).n;
  const rows = d.prepare(`SELECT source, COUNT(*) as n FROM docs GROUP BY source`).all() as Array<{ source: string; n: number }>;
  const bySource: Record<string, number> = {};
  for (const r of rows) bySource[r.source] = r.n;
  return { total, bySource };
}
