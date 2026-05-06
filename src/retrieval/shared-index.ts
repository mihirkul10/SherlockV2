import Database, { type Database as DB } from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { SHARED_INDEX_DB } from "../shared/paths.js";
import { createLogger } from "../shared/logger.js";
import { embedQuery, cosineSimilarity } from "./embeddings.js";
import { summarizeSnippet } from "./chunking.js";
import type {
  ContextStats,
  IndexRunPayloadSchema,
  ManifestItemSchema,
  PreparedDocument,
  SearchFilters,
  SearchHit,
} from "./contracts.js";

const log = createLogger("retrieval:shared-index");

type IndexRunPayload = z.infer<typeof IndexRunPayloadSchema>;
type ManifestItem = z.infer<typeof ManifestItemSchema>;

interface ChunkRow {
  chunk_id: number;
  chunk_index: number;
  text: string;
  embedding_json: string | null;
  title: string;
  author: string | null;
  source: string;
  source_id: string;
  content_id: string;
  url: string | null;
  published_at: string | null;
  path: string;
  lexical_rank?: number;
  lexical_snippet?: string | null;
}

let db: DB | null = null;

function getDb(): DB {
  if (db) return db;
  mkdirSync(dirname(SHARED_INDEX_DB), { recursive: true });
  db = new Database(SHARED_INDEX_DB);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      doc_id            INTEGER PRIMARY KEY AUTOINCREMENT,
      source            TEXT NOT NULL,
      source_id         TEXT NOT NULL,
      content_id        TEXT NOT NULL,
      url               TEXT,
      author            TEXT,
      title             TEXT NOT NULL,
      published_at      TEXT,
      ingested_at       TEXT,
      transcript_status TEXT,
      language          TEXT,
      path              TEXT NOT NULL UNIQUE,
      body_chars        INTEGER,
      raw_sha256        TEXT NOT NULL,
      updated_at        TEXT NOT NULL,
      UNIQUE(source, content_id)
    );
    CREATE INDEX IF NOT EXISTS idx_shared_docs_source ON documents(source);
    CREATE INDEX IF NOT EXISTS idx_shared_docs_source_id ON documents(source, source_id);
    CREATE INDEX IF NOT EXISTS idx_shared_docs_path ON documents(path);
    CREATE INDEX IF NOT EXISTS idx_shared_docs_published ON documents(published_at);

    CREATE TABLE IF NOT EXISTS chunks (
      chunk_id       INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id         INTEGER NOT NULL REFERENCES documents(doc_id) ON DELETE CASCADE,
      chunk_index    INTEGER NOT NULL,
      text           TEXT NOT NULL,
      text_hash      TEXT NOT NULL,
      embedding_json TEXT,
      UNIQUE(doc_id, chunk_index)
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_doc_id ON chunks(doc_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      title,
      body,
      tokenize='porter unicode61 remove_diacritics 2'
    );

    CREATE TABLE IF NOT EXISTS index_runs (
      run_id            TEXT PRIMARY KEY,
      source            TEXT NOT NULL,
      started_at        TEXT NOT NULL,
      finished_at       TEXT NOT NULL,
      status            TEXT NOT NULL,
      changed_docs      INTEGER NOT NULL,
      changed_chunks    INTEGER NOT NULL,
      deleted_docs      INTEGER NOT NULL,
      error_json        TEXT,
      context_revision  TEXT
    );
  `);
  return db;
}

export function closeSharedIndexDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

function buildFtsQuery(q: string): string {
  const tokens = q
    .toLowerCase()
    .replace(/[^a-z0-9\s'"-]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 24);
  if (tokens.length === 0) return '""';
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" ");
}

function buildFilterSql(filters: SearchFilters = {}, docAlias = "d"): { sql: string; params: Record<string, unknown> } {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (filters.sources?.length) {
    where.push(`${docAlias}.source IN (${filters.sources.map((_, i) => `@s${i}`).join(",")})`);
    filters.sources.forEach((value, i) => { params[`s${i}`] = value; });
  }
  if (filters.source_ids?.length) {
    where.push(`${docAlias}.source_id IN (${filters.source_ids.map((_, i) => `@sid${i}`).join(",")})`);
    filters.source_ids.forEach((value, i) => { params[`sid${i}`] = value; });
  }
  if (filters.authors?.length) {
    where.push(`${docAlias}.author IN (${filters.authors.map((_, i) => `@a${i}`).join(",")})`);
    filters.authors.forEach((value, i) => { params[`a${i}`] = value; });
  }
  if (filters.since) {
    where.push(`${docAlias}.published_at >= @since`);
    params["since"] = filters.since;
  }
  if (filters.until) {
    where.push(`${docAlias}.published_at <= @until`);
    params["until"] = filters.until;
  }
  if (filters.language) {
    where.push(`${docAlias}.language = @lang`);
    params["lang"] = filters.language;
  }
  return { sql: where.length > 0 ? ` AND ${where.join(" AND ")}` : "", params };
}

export function upsertPreparedDocument(doc: PreparedDocument): { changedChunks: number } {
  const d = getDb();
  return d.transaction((payload: PreparedDocument) => {
    d.prepare(`
      INSERT INTO documents (
        source, source_id, content_id, url, author, title, published_at,
        ingested_at, transcript_status, language, path, body_chars, raw_sha256, updated_at
      )
      VALUES (
        @source, @source_id, @content_id, @url, @author, @title, @published_at,
        @ingested_at, @transcript_status, @language, @path, @body_chars, @raw_sha256, @updated_at
      )
      ON CONFLICT(source, content_id) DO UPDATE SET
        source_id=excluded.source_id,
        url=excluded.url,
        author=excluded.author,
        title=excluded.title,
        published_at=excluded.published_at,
        ingested_at=excluded.ingested_at,
        transcript_status=excluded.transcript_status,
        language=excluded.language,
        path=excluded.path,
        body_chars=excluded.body_chars,
        raw_sha256=excluded.raw_sha256,
        updated_at=excluded.updated_at
    `).run({
      source: payload.source,
      source_id: payload.source_id,
      content_id: payload.content_id,
      url: payload.url ?? null,
      author: payload.author ?? null,
      title: payload.title,
      published_at: payload.published_at ?? null,
      ingested_at: payload.ingested_at ?? null,
      transcript_status: payload.transcript_status ?? null,
      language: payload.language ?? null,
      path: payload.path,
      body_chars: payload.body.length,
      raw_sha256: payload.raw_sha256,
      updated_at: new Date().toISOString(),
    });

    const row = d.prepare(`SELECT doc_id FROM documents WHERE source=? AND content_id=?`)
      .get(payload.source, payload.content_id) as { doc_id: number } | undefined;
    if (!row) throw new Error(`Missing doc row after upsert: ${payload.source}/${payload.content_id}`);

    d.prepare(`DELETE FROM chunks_fts WHERE rowid IN (SELECT chunk_id FROM chunks WHERE doc_id=?)`).run(row.doc_id);
    d.prepare(`DELETE FROM chunks WHERE doc_id=?`).run(row.doc_id);

    const insertChunk = d.prepare(`
      INSERT INTO chunks (doc_id, chunk_index, text, text_hash, embedding_json)
      VALUES (?, ?, ?, ?, ?)
    `);
    const insertFts = d.prepare(`INSERT INTO chunks_fts (rowid, title, body) VALUES (?, ?, ?)`);

    for (const chunk of payload.chunks) {
      const info = insertChunk.run(
        row.doc_id,
        chunk.chunk_index,
        chunk.text,
        chunk.text_hash,
        chunk.embedding ? JSON.stringify(chunk.embedding) : null,
      );
      insertFts.run(Number(info.lastInsertRowid), payload.title, chunk.text);
    }
    return { changedChunks: payload.chunks.length };
  })(doc) as { changedChunks: number };
}

export function deletePreparedDocuments(paths: string[]): number {
  if (paths.length === 0) return 0;
  const d = getDb();
  return d.transaction((targetPaths: string[]) => {
    let deleted = 0;
    const select = d.prepare(`SELECT doc_id FROM documents WHERE path=?`);
    const deleteFts = d.prepare(`DELETE FROM chunks_fts WHERE rowid IN (SELECT chunk_id FROM chunks WHERE doc_id=?)`);
    const deleteChunks = d.prepare(`DELETE FROM chunks WHERE doc_id=?`);
    const deleteDoc = d.prepare(`DELETE FROM documents WHERE doc_id=?`);
    for (const path of targetPaths) {
      const row = select.get(path) as { doc_id: number } | undefined;
      if (!row) continue;
      deleteFts.run(row.doc_id);
      deleteChunks.run(row.doc_id);
      deleteDoc.run(row.doc_id);
      deleted++;
    }
    return deleted;
  })(paths) as number;
}

export function diffManifest(manifest: ManifestItem[]): { upsert_paths: string[]; delete_paths: string[] } {
  const d = getDb();
  const known = d.prepare(`SELECT path, raw_sha256 FROM documents`).all() as Array<{ path: string; raw_sha256: string }>;
  const remote = new Map(known.map((row) => [row.path, row.raw_sha256]));
  const local = new Map(manifest.map((item) => [item.path, item.raw_sha256]));

  const upsertPaths = manifest
    .filter((item) => remote.get(item.path) !== item.raw_sha256)
    .map((item) => item.path);
  const deletePaths = known
    .filter((row) => !local.has(row.path))
    .map((row) => row.path);
  return { upsert_paths: upsertPaths, delete_paths: deletePaths };
}

export function recordIndexRun(payload: IndexRunPayload): void {
  const d = getDb();
  d.prepare(`
    INSERT INTO index_runs (
      run_id, source, started_at, finished_at, status, changed_docs,
      changed_chunks, deleted_docs, error_json, context_revision
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET
      finished_at=excluded.finished_at,
      status=excluded.status,
      changed_docs=excluded.changed_docs,
      changed_chunks=excluded.changed_chunks,
      deleted_docs=excluded.deleted_docs,
      error_json=excluded.error_json,
      context_revision=excluded.context_revision
  `).run(
    payload.run_id,
    payload.source,
    payload.started_at,
    payload.finished_at,
    payload.status,
    payload.changed_docs,
    payload.changed_chunks,
    payload.deleted_docs,
    JSON.stringify(payload.errors ?? []),
    payload.context_revision ?? null,
  );
}

export function getSharedStats(): ContextStats {
  const d = getDb();
  const totals = d.prepare(`
    SELECT
      (SELECT COUNT(*) FROM documents) AS total_docs,
      (SELECT COUNT(*) FROM chunks) AS total_chunks,
      (SELECT MAX(published_at) FROM documents) AS newest_published_at,
      (SELECT MAX(updated_at) FROM documents) AS newest_indexed_at
  `).get() as {
    total_docs: number;
    total_chunks: number;
    newest_published_at: string | null;
    newest_indexed_at: string | null;
  };
  const rows = d.prepare(`SELECT source, COUNT(*) AS n FROM documents GROUP BY source`).all() as Array<{ source: string; n: number }>;
  const bySource: Record<string, number> = {};
  for (const row of rows) bySource[row.source] = row.n;
  return {
    total: totals.total_docs,
    total_chunks: totals.total_chunks,
    newest_published_at: totals.newest_published_at,
    newest_indexed_at: totals.newest_indexed_at,
    bySource,
  };
}

function lexicalCandidates(query: string, filters: SearchFilters, limit: number): ChunkRow[] {
  const d = getDb();
  const { sql: filterSql, params: filterParams } = buildFilterSql(filters);
  const fts = buildFtsQuery(query);
  if (fts === '""') return [];
  return d.prepare(`
    SELECT
      c.chunk_id,
      c.chunk_index,
      c.text,
      c.embedding_json,
      d.title,
      d.author,
      d.source,
      d.source_id,
      d.content_id,
      d.url,
      d.published_at,
      d.path,
      snippet(chunks_fts, 1, '**', '**', '…', 24) AS lexical_snippet,
      bm25(chunks_fts) AS lexical_rank
    FROM chunks_fts
    JOIN chunks c ON c.chunk_id = chunks_fts.rowid
    JOIN documents d ON d.doc_id = c.doc_id
    WHERE chunks_fts MATCH @fts
    ${filterSql}
    ORDER BY lexical_rank
    LIMIT @limit
  `).all({ fts, limit, ...filterParams }) as ChunkRow[];
}

function semanticCandidates(filters: SearchFilters, limit: number): ChunkRow[] {
  const d = getDb();
  const { sql: filterSql, params } = buildFilterSql(filters);
  return d.prepare(`
    SELECT
      c.chunk_id,
      c.chunk_index,
      c.text,
      c.embedding_json,
      d.title,
      d.author,
      d.source,
      d.source_id,
      d.content_id,
      d.url,
      d.published_at,
      d.path
    FROM chunks c
    JOIN documents d ON d.doc_id = c.doc_id
    WHERE c.embedding_json IS NOT NULL
    ${filterSql}
    ORDER BY COALESCE(d.published_at, '') DESC
    LIMIT @limit
  `).all({ limit, ...params }) as ChunkRow[];
}

export async function searchSharedIndex(
  query: string,
  filters: SearchFilters = {},
  limit = 10,
): Promise<SearchHit[]> {
  const lexical = lexicalCandidates(query, filters, Math.max(limit * 6, 20));
  const queryEmbedding = await embedQuery(query);
  const semanticPool = queryEmbedding ? semanticCandidates(filters, 3000) : [];
  const byChunk = new Map<number, SearchHit>();

  for (const [idx, row] of lexical.entries()) {
    const lexicalScore = 1 / (1 + idx);
    byChunk.set(row.chunk_id, {
      title: row.title,
      author: row.author,
      source: row.source,
      source_id: row.source_id,
      content_id: row.content_id,
      url: row.url,
      published_at: row.published_at,
      snippet: row.lexical_snippet ?? summarizeSnippet(row.text),
      path: row.path,
      score: lexicalScore,
      lexical_score: lexicalScore,
      semantic_score: 0,
      chunk_index: row.chunk_index,
    });
  }

  if (queryEmbedding) {
    for (const row of semanticPool) {
      const stored = row.embedding_json ? JSON.parse(row.embedding_json) as number[] : null;
      if (!stored) continue;
      const semantic = Math.max(0, cosineSimilarity(queryEmbedding, stored));
      const existing = byChunk.get(row.chunk_id);
      const lexicalScore = existing?.lexical_score ?? 0;
      if (!existing && lexical.length > 0 && semantic < 0.6) continue;
      if (!existing && lexical.length === 0 && semantic < 0.5) continue;
      const score = lexicalScore > 0 ? (lexicalScore * 0.75) + (semantic * 0.25) : semantic;
      if (score <= 0) continue;
      byChunk.set(row.chunk_id, {
        title: row.title,
        author: row.author,
        source: row.source,
        source_id: row.source_id,
        content_id: row.content_id,
        url: row.url,
        published_at: row.published_at,
        snippet: existing?.snippet ?? summarizeSnippet(row.text),
        path: row.path,
        score,
        lexical_score: lexicalScore,
        semantic_score: semantic,
        chunk_index: row.chunk_index,
      });
    }
  }

  const byDocument = new Map<string, SearchHit>();
  for (const hit of byChunk.values()) {
    const key = `${hit.source}:${hit.content_id}`;
    const existing = byDocument.get(key);
    if (!existing || hit.score > existing.score) byDocument.set(key, hit);
  }

  const results = [...byDocument.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  log.info({ query, limit, filters, hits: results.length, semantic: Boolean(queryEmbedding) }, "shared search");
  return results;
}
