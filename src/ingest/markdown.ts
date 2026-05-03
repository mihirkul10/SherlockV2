/**
 * Normalize raw ingested content into the SherlockV2 Markdown frontmatter
 * shape spec'd in plan §3.
 *
 *   ---
 *   source: youtube|substack|twitter-people|twitter-bookmarks|blog
 *   source_id: <stable id>
 *   content_id: <stable per-item id>
 *   url: ...
 *   author: ...
 *   published_at: ISO8601
 *   ingested_at: ISO8601
 *   title: ...
 *   transcript_status: ok|unavailable    # YouTube only
 *   ---
 *   <body>
 */

import type { SourceType } from "../shared/sources-schema.js";

export interface MarkdownDoc {
  source: SourceType;
  source_id: string;
  content_id: string;
  url: string;
  author: string;
  published_at: string; // ISO8601
  title: string;
  body: string;
  // optional flags:
  transcript_status?: "ok" | "unavailable" | "partial";
  language?: string;
  language_name?: string;
  segment_count?: number;
  extras?: Record<string, string | number | boolean | null>;
}

function escapeYamlString(s: string): string {
  // Wrap in double quotes and escape inner double quotes + backslashes
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

function isSafeBareYamlValue(s: string): boolean {
  // Use bare value only for simple strings without special chars
  return /^[A-Za-z0-9_./:+\-@]+$/.test(s);
}

function yamlValue(v: unknown): string {
  if (v == null) return "null";
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  const s = String(v);
  return isSafeBareYamlValue(s) ? s : escapeYamlString(s);
}

export function renderMarkdown(doc: MarkdownDoc): string {
  const lines: string[] = ["---"];
  lines.push(`source: ${doc.source}`);
  lines.push(`source_id: ${yamlValue(doc.source_id)}`);
  lines.push(`content_id: ${yamlValue(doc.content_id)}`);
  lines.push(`url: ${yamlValue(doc.url)}`);
  lines.push(`author: ${yamlValue(doc.author)}`);
  lines.push(`published_at: ${doc.published_at}`);
  lines.push(`ingested_at: ${new Date().toISOString()}`);
  lines.push(`title: ${yamlValue(doc.title)}`);
  if (doc.transcript_status) lines.push(`transcript_status: ${doc.transcript_status}`);
  if (doc.language) lines.push(`language: ${yamlValue(doc.language)}`);
  if (doc.language_name) lines.push(`language_name: ${yamlValue(doc.language_name)}`);
  if (typeof doc.segment_count === "number") lines.push(`segment_count: ${doc.segment_count}`);
  if (doc.extras) {
    for (const [k, v] of Object.entries(doc.extras)) {
      lines.push(`${k}: ${yamlValue(v)}`);
    }
  }
  lines.push("---");
  lines.push("");
  lines.push(`# ${doc.title}`);
  lines.push("");
  lines.push(doc.body.trim());
  lines.push("");
  return lines.join("\n");
}

/** Filename-safe slug derived from a title or url. */
export function slugify(input: string, maxLen = 60): string {
  const s = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen);
  return s || "untitled";
}

/** YYYY-MM-DD from an ISO8601 string. */
export function isoDate(iso: string): string {
  return iso.slice(0, 10);
}
