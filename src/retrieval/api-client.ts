import { optionalEnv } from "../shared/env.js";
import {
  AdminCorpusDocResponseSchema,
  AdminCorpusListInputSchema,
  AdminCorpusListResponseSchema,
  BriefInputSchema,
  ContextBriefSchema,
  ContextFollowupsSchema,
  FollowupsInputSchema,
  SearchInputSchema,
  SearchResponseSchema,
  StatsInputSchema,
  StatsResponseSchema,
} from "./contracts.js";

function baseUrl(): string {
  const url = optionalEnv("SHERLOCK_CONTEXT_API_URL");
  if (!url) throw new Error("SHERLOCK_CONTEXT_API_URL is not configured");
  return url.replace(/\/$/, "");
}

function authHeaders(): Record<string, string> {
  const token = optionalEnv("SHERLOCK_CONTEXT_API_TOKEN");
  return token ? { "Authorization": `Bearer ${token}` } : {};
}

async function jsonRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Context API ${path} failed (${response.status}): ${body.slice(0, 300)}`);
  }
  return await response.json() as T;
}

export async function remoteSearch(raw: unknown) {
  const input = SearchInputSchema.parse(raw);
  const response = await jsonRequest<unknown>("/query/search", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return SearchResponseSchema.parse(response);
}

export async function remoteStats(raw: unknown) {
  StatsInputSchema.parse(raw ?? {});
  const response = await jsonRequest<unknown>("/query/stats");
  return StatsResponseSchema.parse(response);
}

export async function remoteAdminCorpusList(raw: unknown) {
  const input = AdminCorpusListInputSchema.parse(raw ?? {});
  const params = new URLSearchParams();
  if (input.source) params.set("source", input.source);
  if (input.author) params.set("author", input.author);
  if (input.q) params.set("q", input.q);
  params.set("limit", String(input.limit));
  params.set("offset", String(input.offset));
  const response = await jsonRequest<unknown>(`/admin/corpus?${params.toString()}`, {
    method: "GET",
  });
  return AdminCorpusListResponseSchema.parse(response);
}

export async function remoteAdminCorpusDoc(docId: number) {
  const response = await fetch(`${baseUrl()}/admin/corpus/${docId}`, {
    method: "GET",
    headers: authHeaders(),
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Context API /admin/corpus/${docId} failed (${response.status}): ${body.slice(0, 300)}`);
  }
  return AdminCorpusDocResponseSchema.parse(await response.json());
}

export async function remoteBrief(raw: unknown) {
  const input = BriefInputSchema.parse(raw);
  const response = await jsonRequest<unknown>("/query/brief", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return ContextBriefSchema.parse(response);
}

export async function remoteFollowups(raw: unknown) {
  const input = FollowupsInputSchema.parse(raw);
  const response = await jsonRequest<unknown>("/query/followups", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return ContextFollowupsSchema.parse(response);
}
