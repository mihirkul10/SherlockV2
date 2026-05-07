/**
 * Corpus file explorer.
 *
 * Runtime is remote-only: the admin corpus browser always reflects the shared
 * retrieval API, which is the single searchable corpus backend for Sherlock.
 */

import { remoteAdminCorpusDoc, remoteAdminCorpusList } from "../retrieval/api-client.js";

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
  /** Stored corpus path as returned by the shared API. */
  abs_path: string;
  /** Document body returned by the shared API. */
  body: string;
  /** Size on disk in bytes. */
  size_bytes: number;
  /** Whether the body came from raw markdown or indexed chunk reconstruction. */
  body_origin?: "raw-markdown" | "reconstructed-chunks";
}

export async function listDocs(opts: {
  source?: string;
  author?: string;
  q?: string;
  limit?: number;
  offset?: number;
}): Promise<CorpusList> {
  try {
    return await remoteAdminCorpusList(opts);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`remote corpus explorer failed; redeploy the shared context API to pick up /admin/corpus endpoints (${message})`);
  }
}

/** Fetch one doc + its body. Returns null if unknown. */
export async function getDoc(docId: number): Promise<CorpusDoc | null> {
  try {
    return await remoteAdminCorpusDoc(docId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`remote corpus doc lookup failed; redeploy the shared context API to pick up /admin/corpus endpoints (${message})`);
  }
}
