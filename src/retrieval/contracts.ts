import { z } from "zod";

export const ContextSourceSchema = z.enum([
  "youtube",
  "substack",
  "twitter-people",
  "twitter-bookmarks",
  "blog",
]);

export const SearchFiltersSchema = z.object({
  sources: z.array(ContextSourceSchema).optional(),
  source_ids: z.array(z.string()).optional(),
  authors: z.array(z.string()).optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  language: z.string().optional(),
});

export type SearchFilters = z.infer<typeof SearchFiltersSchema>;

export const SearchInputSchema = z.object({
  query: z.string().min(1),
  filters: SearchFiltersSchema.optional(),
  limit: z.number().int().min(1).max(50).default(10),
});

export const StatsInputSchema = z.object({});

export const BriefInputSchema = z.object({
  topic: z.string().min(2),
  user_question: z.string().optional(),
  filters: SearchFiltersSchema.optional(),
  limit: z.number().int().min(3).max(20).default(8),
});

export const FollowupsInputSchema = z.object({
  topic: z.string().min(2),
  user_question: z.string().optional(),
  filters: SearchFiltersSchema.optional(),
  limit: z.number().int().min(3).max(20).default(8),
});

export interface SearchHit {
  title: string;
  author: string | null;
  source: string;
  source_id: string;
  content_id: string;
  url: string | null;
  published_at: string | null;
  snippet: string;
  path: string;
  score: number;
  lexical_score: number;
  semantic_score: number;
  chunk_index?: number;
}

export interface ContextStats {
  total: number;
  total_chunks?: number;
  newest_published_at?: string | null;
  newest_indexed_at?: string | null;
  bySource: Record<string, number>;
}

export interface ContextBrief {
  summary: string;
  themes: string[];
  gaps: string[];
  contradictions: string[];
  recommendations: string[];
  hits: SearchHit[];
}

export interface FollowupQuestion {
  question: string;
  why: string;
  evidence: Array<Pick<SearchHit, "title" | "author" | "source" | "url" | "published_at">>;
}

export interface ContextFollowups {
  questions: FollowupQuestion[];
  handoff_note: string;
  hits: SearchHit[];
}

export const SearchHitSchema = z.object({
  title: z.string(),
  author: z.string().nullable(),
  source: z.string(),
  source_id: z.string(),
  content_id: z.string(),
  url: z.string().nullable(),
  published_at: z.string().nullable(),
  snippet: z.string(),
  path: z.string(),
  score: z.number(),
  lexical_score: z.number(),
  semantic_score: z.number(),
  chunk_index: z.number().int().optional(),
});

export const SearchResponseSchema = z.object({
  hits: z.array(SearchHitSchema),
  total_returned: z.number().int(),
});

export const StatsResponseSchema = z.object({
  total: z.number().int(),
  total_chunks: z.number().int().optional(),
  newest_published_at: z.string().nullable().optional(),
  newest_indexed_at: z.string().nullable().optional(),
  bySource: z.record(z.string(), z.number().int()),
});

export const ContextBriefSchema = z.object({
  summary: z.string(),
  themes: z.array(z.string()),
  gaps: z.array(z.string()),
  contradictions: z.array(z.string()),
  recommendations: z.array(z.string()),
  hits: z.array(SearchHitSchema),
});

export const FollowupQuestionSchema = z.object({
  question: z.string(),
  why: z.string(),
  evidence: z.array(z.object({
    title: z.string(),
    author: z.string().nullable(),
    source: z.string(),
    url: z.string().nullable(),
    published_at: z.string().nullable(),
  })),
});

export const ContextFollowupsSchema = z.object({
  questions: z.array(FollowupQuestionSchema),
  handoff_note: z.string(),
  hits: z.array(SearchHitSchema),
});

export interface PreparedChunk {
  chunk_index: number;
  text: string;
  text_hash: string;
  embedding?: number[];
}

export interface PreparedDocument {
  source: string;
  source_id: string;
  content_id: string;
  title: string;
  body: string;
  path: string;
  raw_sha256: string;
  url?: string;
  author?: string;
  published_at?: string;
  ingested_at?: string;
  transcript_status?: string;
  language?: string;
  chunks: PreparedChunk[];
}

export const PreparedChunkSchema = z.object({
  chunk_index: z.number().int().min(0),
  text: z.string().min(1),
  text_hash: z.string().min(8),
  embedding: z.array(z.number()).optional(),
});

export const PreparedDocumentSchema = z.object({
  source: z.string().min(1),
  source_id: z.string(),
  content_id: z.string().min(1),
  title: z.string().min(1),
  body: z.string(),
  path: z.string().min(1),
  raw_sha256: z.string().min(8),
  url: z.string().optional(),
  author: z.string().optional(),
  published_at: z.string().optional(),
  ingested_at: z.string().optional(),
  transcript_status: z.string().optional(),
  language: z.string().optional(),
  chunks: z.array(PreparedChunkSchema),
});

export const ManifestItemSchema = z.object({
  path: z.string().min(1),
  raw_sha256: z.string().min(8),
});

export const ManifestDiffRequestSchema = z.object({
  manifest: z.array(ManifestItemSchema),
});

export const ManifestDiffResponseSchema = z.object({
  upsert_paths: z.array(z.string()),
  delete_paths: z.array(z.string()),
});

export const UpsertDocumentsRequestSchema = z.object({
  documents: z.array(PreparedDocumentSchema),
});

export const DeleteDocumentsRequestSchema = z.object({
  paths: z.array(z.string().min(1)),
});

export const IndexRunPayloadSchema = z.object({
  run_id: z.string().min(1),
  source: z.string().default("cloud-indexer"),
  started_at: z.string(),
  finished_at: z.string(),
  status: z.enum(["ok", "partial", "error"]),
  changed_docs: z.number().int().min(0),
  changed_chunks: z.number().int().min(0),
  deleted_docs: z.number().int().min(0),
  errors: z.array(z.string()).default([]),
  context_revision: z.string().optional(),
});
