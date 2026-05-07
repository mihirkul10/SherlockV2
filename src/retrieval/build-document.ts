import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { chunkDocument } from "./chunking.js";
import { embedTexts } from "./embeddings.js";
import type { PreparedDocument } from "./contracts.js";
import { parseMarkdown } from "../shared/markdown-document.js";
import { toContextRelativePath } from "../shared/paths.js";

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export async function buildPreparedDocument(path: string): Promise<PreparedDocument | null> {
  const raw = readFileSync(path, "utf-8");
  const { frontmatter, body } = parseMarkdown(raw);
  if (!frontmatter["source"] || !frontmatter["content_id"]) return null;
  const relativePath = toContextRelativePath(path);

  const chunks = chunkDocument(body);
  const vectors = chunks.length > 0 ? await embedTexts(chunks.map((chunk) => chunk.text)) : null;
  return {
    source: frontmatter["source"]!,
    source_id: frontmatter["source_id"] ?? "",
    content_id: frontmatter["content_id"]!,
    title: frontmatter["title"] ?? relativePath,
    body,
    path: relativePath,
    raw_sha256: sha(raw),
    ...(frontmatter["url"] ? { url: frontmatter["url"] } : {}),
    ...(frontmatter["author"] ? { author: frontmatter["author"] } : {}),
    ...(frontmatter["published_at"] ? { published_at: frontmatter["published_at"] } : {}),
    ...(frontmatter["ingested_at"] ? { ingested_at: frontmatter["ingested_at"] } : {}),
    ...(frontmatter["transcript_status"] ? { transcript_status: frontmatter["transcript_status"] } : {}),
    ...(frontmatter["language"] ? { language: frontmatter["language"] } : {}),
    chunks: chunks.map((chunk, idx) => ({
      chunk_index: chunk.chunk_index,
      text: chunk.text,
      text_hash: chunk.text_hash,
      ...(vectors?.[idx] ? { embedding: vectors[idx] } : {}),
    })),
  };
}
