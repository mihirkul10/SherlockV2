import { optionalEnv } from "../shared/env.js";

const VOYAGE_EMBEDDINGS_URL = "https://api.voyageai.com/v1/embeddings";
const DEFAULT_MODEL = process.env["SHERLOCK_EMBEDDING_MODEL"] ?? "voyage-3-lite";

interface VoyageEmbeddingDatum {
  embedding: number[];
  index: number;
}

interface VoyageEmbeddingResponse {
  data?: VoyageEmbeddingDatum[];
}

export function embeddingsEnabled(): boolean {
  return Boolean(optionalEnv("VOYAGE_API_KEY"));
}

export async function embedTexts(texts: string[]): Promise<number[][] | null> {
  const apiKey = optionalEnv("VOYAGE_API_KEY");
  if (!apiKey || texts.length === 0) return null;

  const response = await fetch(VOYAGE_EMBEDDINGS_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      input: texts,
      input_type: "document",
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Voyage embeddings failed (${response.status}): ${text.slice(0, 300)}`);
  }

  const json = await response.json() as VoyageEmbeddingResponse;
  const rows = (json.data ?? [])
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((item) => item.embedding);
  if (rows.length !== texts.length) {
    throw new Error(`Voyage embeddings count mismatch: expected ${texts.length}, got ${rows.length}`);
  }
  return rows;
}

export async function embedQuery(text: string): Promise<number[] | null> {
  const apiKey = optionalEnv("VOYAGE_API_KEY");
  if (!apiKey || !text.trim()) return null;

  const response = await fetch(VOYAGE_EMBEDDINGS_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      input: [text],
      input_type: "query",
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Voyage query embedding failed (${response.status}): ${body.slice(0, 300)}`);
  }

  const json = await response.json() as VoyageEmbeddingResponse;
  const embedding = json.data?.[0]?.embedding;
  return embedding ?? null;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    aNorm += a[i]! * a[i]!;
    bNorm += b[i]! * b[i]!;
  }
  if (aNorm === 0 || bNorm === 0) return 0;
  return dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm));
}
