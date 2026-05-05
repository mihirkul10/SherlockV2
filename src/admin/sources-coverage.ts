/**
 * Per-source coverage view.
 *
 * Reads sherlock-context/_state/sources.json (the roster) plus each
 * <source>-state.json (the polling state), joins them, and returns
 * a normalized per-source list the dashboard can render directly.
 *
 * For each source category (youtube / twitter_people / substack / blog
 * / twitter_bookmarks) we return rows of:
 *   { key, name, handle, items_known, last_checked, last_item_id, last_error }
 *
 * Read-only.
 */

import { existsSync, readFileSync } from "node:fs";
import { CONTEXT_STATE_DIR, SOURCES_JSON, stateFilePath } from "../shared/paths.js";

export interface CoverageRow {
  key: string;
  name?: string;
  handle?: string;
  url?: string;
  items_known: number;
  last_checked?: string;
  last_item_id?: string;
  /** Real failure (network, auth, parse). Surfaced in red. */
  last_error?: string;
  /** "No transcript / no content available" — normal for many YT videos.
   *  Surfaced in dim text, not red. */
  last_no_content?: string;
}

/**
 * Buckets `lastError` from the per-source state file into a real error vs
 * a "no content available" notice. Many YouTube videos legitimately have
 * no transcript (livestream, captions disabled, music) — the actor reports
 * this as an error string but it's not a failure of the pipeline.
 */
function bucketLastError(raw: string | undefined): { error?: string; noContent?: string } {
  if (!raw) return {};
  // YouTube transcript actor's "soft" failures.
  if (/empty transcript returned by actor/i.test(raw)) return { noContent: "no captions available for the latest video" };
  if (/transcript[^a-z]+unavailable/i.test(raw)) return { noContent: "captions not available" };
  if (/no captions/i.test(raw)) return { noContent: raw };
  return { error: raw };
}

export interface CoverageReport {
  generated_at: string;
  context_state_dir: string;
  sources_json_exists: boolean;
  youtube: CoverageRow[];
  twitter_people: CoverageRow[];
  substack: CoverageRow[];
  blog: CoverageRow[];
  twitter_bookmarks: CoverageRow[];
}

function readJson<T = unknown>(path: string): T | null {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf-8")) as T; }
  catch { return null; }
}

function pickArr(j: unknown, ...paths: string[][]): unknown[] {
  for (const p of paths) {
    let cur: unknown = j;
    for (const seg of p) {
      if (cur && typeof cur === "object" && seg in (cur as Record<string, unknown>)) {
        cur = (cur as Record<string, unknown>)[seg];
      } else { cur = null; break; }
    }
    if (Array.isArray(cur)) return cur;
  }
  return [];
}

function pickObj(j: unknown, ...paths: string[][]): Record<string, unknown> | null {
  for (const p of paths) {
    let cur: unknown = j;
    for (const seg of p) {
      if (cur && typeof cur === "object" && seg in (cur as Record<string, unknown>)) {
        cur = (cur as Record<string, unknown>)[seg];
      } else { cur = null; break; }
    }
    if (cur && typeof cur === "object" && !Array.isArray(cur)) {
      return cur as Record<string, unknown>;
    }
  }
  return null;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function asNumber(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}
function arrLen(v: unknown): number {
  return Array.isArray(v) ? v.length : 0;
}

export function buildCoverage(): CoverageReport {
  const sources = readJson(SOURCES_JSON) ?? {};

  const ytState = readJson<Record<string, unknown>>(stateFilePath("youtube")) ?? {};
  const twPeopleState = readJson<Record<string, unknown>>(stateFilePath("twitter-people")) ?? {};
  const twBookmarksState = readJson<Record<string, unknown>>(stateFilePath("twitter-bookmarks")) ?? {};
  const subState = readJson<Record<string, unknown>>(stateFilePath("substack")) ?? {};
  const blogState = readJson<Record<string, unknown>>(stateFilePath("blogs")) ?? {};

  // ─── YouTube ─────────────────────────────────────────────────────────
  const ytChannels = pickArr(sources, ["youtube", "channels"], ["youtube"]);
  const youtube: CoverageRow[] = ytChannels.map((raw) => {
    const ch = (raw ?? {}) as Record<string, unknown>;
    const channelId = asString(ch["channelId"]) ?? asString(ch["channel_id"]) ?? asString(ch["id"]) ?? "";
    const st = (ytState[channelId] ?? {}) as Record<string, unknown>;
    const row: CoverageRow = {
      key: channelId,
      items_known: arrLen(st["knownVideoIds"]),
    };
    const name = asString(ch["name"]);
    const handle = asString(ch["handle"]);
    const lastChecked = asString(st["lastChecked"]);
    const lastVideoId = asString(st["lastVideoId"]);
    const bucketed = bucketLastError(asString(st["lastError"]));
    if (name) row.name = name;
    if (handle) row.handle = handle;
    if (lastChecked) row.last_checked = lastChecked;
    if (lastVideoId) row.last_item_id = lastVideoId;
    if (bucketed.error) row.last_error = bucketed.error;
    if (bucketed.noContent) row.last_no_content = bucketed.noContent;
    return row;
  });

  // ─── Twitter people ──────────────────────────────────────────────────
  const twPeople = pickArr(sources, ["twitter", "people"], ["twitter_people"]);
  const twitter_people: CoverageRow[] = twPeople.map((raw) => {
    const p = (raw ?? {}) as Record<string, unknown>;
    const userId = asString(p["userId"]) ?? asString(p["user_id"]) ?? asString(p["id"]) ?? "";
    const st = (twPeopleState[userId] ?? {}) as Record<string, unknown>;
    const row: CoverageRow = {
      key: userId,
      items_known: arrLen(st["knownTweetIds"]),
    };
    const name = asString(p["name"]);
    const handle = asString(p["handle"]);
    const lastChecked = asString(st["lastChecked"]);
    const lastTweetId = asString(st["lastTweetId"]);
    const bucketed = bucketLastError(asString(st["lastError"]));
    if (name) row.name = name;
    if (handle) row.handle = handle;
    if (lastChecked) row.last_checked = lastChecked;
    if (lastTweetId) row.last_item_id = lastTweetId;
    if (bucketed.error) row.last_error = bucketed.error;
    if (bucketed.noContent) row.last_no_content = bucketed.noContent;
    return row;
  });

  // ─── Substack ────────────────────────────────────────────────────────
  const subList = pickArr(sources, ["substack", "newsletters"], ["substack"]);
  const substack: CoverageRow[] = subList.map((raw) => {
    const s = (raw ?? {}) as Record<string, unknown>;
    const subdomain = asString(s["subdomain"]) ?? asString(s["id"]) ?? "";
    const st = (subState[subdomain] ?? {}) as Record<string, unknown>;
    const row: CoverageRow = {
      key: subdomain,
      items_known: arrLen(st["knownPostIds"]),
    };
    const name = asString(s["name"]);
    if (name) row.name = name;
    if (subdomain) row.handle = subdomain;
    const lastChecked = asString(st["lastChecked"]);
    const lastPostId = asString(st["lastPostId"]);
    const bucketed = bucketLastError(asString(st["lastError"]));
    if (lastChecked) row.last_checked = lastChecked;
    if (lastPostId) row.last_item_id = lastPostId;
    if (bucketed.error) row.last_error = bucketed.error;
    if (bucketed.noContent) row.last_no_content = bucketed.noContent;
    return row;
  });

  // ─── Blogs ───────────────────────────────────────────────────────────
  const blogList = pickArr(sources, ["blogs", "feeds"], ["blog", "feeds"], ["blog"]);
  const blog: CoverageRow[] = blogList.map((raw) => {
    const b = (raw ?? {}) as Record<string, unknown>;
    const url = asString(b["url"]) ?? "";
    const st = (blogState[url] ?? {}) as Record<string, unknown>;
    const row: CoverageRow = {
      key: url,
      items_known: arrLen(st["knownEntryIds"]),
    };
    const name = asString(b["name"]);
    if (name) row.name = name;
    if (url) row.url = url;
    const lastChecked = asString(st["lastChecked"]);
    const lastEntryId = asString(st["lastEntryId"]);
    const bucketed = bucketLastError(asString(st["lastError"]));
    if (lastChecked) row.last_checked = lastChecked;
    if (lastEntryId) row.last_item_id = lastEntryId;
    if (bucketed.error) row.last_error = bucketed.error;
    if (bucketed.noContent) row.last_no_content = bucketed.noContent;
    return row;
  });

  // ─── Twitter bookmarks (single-row) ──────────────────────────────────
  const twitter_bookmarks: CoverageRow[] = [];
  const bm = pickObj(sources, ["twitter", "bookmarks"]);
  if (bm) {
    const userId = asString(bm["userId"]) ?? asString(bm["user_id"]) ?? "";
    const st = (twBookmarksState[userId] ?? {}) as Record<string, unknown>;
    const row: CoverageRow = {
      key: userId,
      items_known: arrLen(st["knownTweetIds"]),
    };
    const handle = asString(bm["handle"]);
    if (handle) row.handle = handle;
    const lastChecked = asString(st["lastChecked"]);
    const lastTweetId = asString(st["lastTweetId"]);
    const bucketed = bucketLastError(asString(st["lastError"]));
    if (lastChecked) row.last_checked = lastChecked;
    if (lastTweetId) row.last_item_id = lastTweetId;
    if (bucketed.error) row.last_error = bucketed.error;
    if (bucketed.noContent) row.last_no_content = bucketed.noContent;
    twitter_bookmarks.push(row);
  }

  // Sort by name (then handle/url) for stable display.
  const cmp = (a: CoverageRow, b: CoverageRow) =>
    (a.name ?? a.handle ?? a.url ?? a.key).localeCompare(b.name ?? b.handle ?? b.url ?? b.key);
  youtube.sort(cmp);
  twitter_people.sort(cmp);
  substack.sort(cmp);
  blog.sort(cmp);
  // Avoid TS unused-variable warnings (asNumber kept for future numeric fields).
  void asNumber;

  return {
    generated_at: new Date().toISOString(),
    context_state_dir: CONTEXT_STATE_DIR,
    sources_json_exists: existsSync(SOURCES_JSON),
    youtube,
    twitter_people,
    substack,
    blog,
    twitter_bookmarks,
  };
}
