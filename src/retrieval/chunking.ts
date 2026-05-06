import { createHash } from "node:crypto";

export interface ChunkedText {
  chunk_index: number;
  text: string;
  text_hash: string;
}

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function normalizeParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

export function summarizeSnippet(text: string, maxChars = 220): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trim()}…`;
}

export function chunkDocument(text: string, maxChars = 900, overlapChars = 160): ChunkedText[] {
  const paragraphs = normalizeParagraphs(text);
  if (paragraphs.length === 0) {
    const single = text.trim();
    return single
      ? [{ chunk_index: 0, text: single, text_hash: sha(single) }]
      : [];
  }

  const chunks: ChunkedText[] = [];
  let current = "";
  let currentIndex = 0;

  const pushCurrent = (): void => {
    const trimmed = current.trim();
    if (!trimmed) return;
    chunks.push({
      chunk_index: currentIndex++,
      text: trimmed,
      text_hash: sha(trimmed),
    });
    if (overlapChars <= 0) {
      current = "";
      return;
    }
    const overlap = trimmed.slice(Math.max(0, trimmed.length - overlapChars)).trim();
    current = overlap ? `${overlap}\n\n` : "";
  };

  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}${paragraph}` : paragraph;
    if (candidate.length > maxChars && current.trim()) {
      pushCurrent();
      current = `${current}${paragraph}`.trim();
      if (current.length > maxChars) {
        chunks.push({
          chunk_index: currentIndex++,
          text: current,
          text_hash: sha(current),
        });
        current = "";
      }
      continue;
    }

    current = candidate;
    if (current.length >= maxChars) pushCurrent();
    else current = `${current}\n\n`;
  }

  pushCurrent();
  return chunks;
}
