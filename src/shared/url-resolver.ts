/**
 * URL resolver — paste any URL, get a normalized source spec ready to insert
 * into sources.json.
 *
 * Pipeline (per plan §9):
 *   1. Canonicalize (strip utm_*, normalize www, rewrite x.com<->twitter.com)
 *   2. Classify by host pattern → source type
 *   3. Resolve to canonical id via the source's API (uses ingest/resolvers.ts)
 *   4. Dedupe against sources.json
 *   5. Validate by hitting the source once
 *   6. Patch sources.json + git commit + push to sherlock-context
 *   7. Return { type, sourceId, name, status, message }
 *
 * Backfill is not enqueued automatically here — caller decides via the
 * runIngestNow option (defaults to false; the regular cron will pick it up).
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CONTEXT_PATH, SOURCES_JSON } from "./paths.js";
import { requireEnv } from "./env.js";
import { createLogger } from "./logger.js";
import {
  SourcesConfigSchema,
  type SourcesConfig,
  type SourceType,
} from "./sources-schema.js";
import {
  resolveYouTubeByHandle,
  resolveYouTubeById,
  resolveYouTubeBySearch,
  resolveTwitterByHandle,
  resolveSubstack,
  resolveBlogFeed,
  discoverFeedUrl,
} from "../ingest/resolvers.js";

const exec = promisify(execFile);
const log = createLogger("shared:url-resolver");

export interface ResolveResult {
  ok: boolean;
  type?: SourceType;
  sourceId?: string;        // canonical id (channelId, userId, subdomain, feed url)
  name?: string;
  status: "added" | "duplicate" | "error";
  message: string;
  warnings?: string[];
}

// ─── Canonicalization ─────────────────────────────────────────────────

function canonicalize(input: string): URL | null {
  let s = input.trim();
  // Add scheme if missing
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  let u: URL;
  try { u = new URL(s); } catch { return null; }
  // Lowercase host
  u.hostname = u.hostname.toLowerCase();
  // Strip leading www.
  if (u.hostname.startsWith("www.")) u.hostname = u.hostname.slice(4);
  // Rewrite twitter.com → x.com
  if (u.hostname === "twitter.com") u.hostname = "x.com";
  // Strip utm_* and other tracking params
  for (const key of [...u.searchParams.keys()]) {
    if (key.startsWith("utm_") || key === "ref" || key === "fbclid" || key === "gclid") {
      u.searchParams.delete(key);
    }
  }
  // Strip fragment
  u.hash = "";
  return u;
}

// ─── Classification ───────────────────────────────────────────────────

interface Classification {
  type: SourceType;
  hint: { kind: "yt-handle" | "yt-channel-id" | "yt-custom"; value: string }
      | { kind: "tw-handle"; value: string }
      | { kind: "ss-subdomain"; value: string }
      | { kind: "blog-feed" | "blog-site"; value: string };
}

function classify(u: URL): Classification | null {
  const host = u.hostname;
  const path = u.pathname;

  // YouTube
  if (host === "youtube.com" || host === "m.youtube.com") {
    if (path.startsWith("/channel/")) {
      const id = path.slice("/channel/".length).split("/")[0]!;
      return { type: "youtube", hint: { kind: "yt-channel-id", value: id } };
    }
    if (path.startsWith("/@")) {
      const handle = path.slice(1).split("/")[0]!; // includes leading @
      return { type: "youtube", hint: { kind: "yt-handle", value: handle } };
    }
    if (path.startsWith("/c/")) {
      const slug = path.slice("/c/".length).split("/")[0]!;
      return { type: "youtube", hint: { kind: "yt-custom", value: slug } };
    }
    return null;
  }

  // Twitter / X
  if (host === "x.com") {
    const seg = path.split("/").filter(Boolean)[0];
    if (!seg) return null;
    // Skip URLs that aren't profile roots (e.g. /home, /search, /i/...)
    if (["home", "search", "i", "explore", "notifications", "messages", "settings"].includes(seg)) return null;
    return { type: "twitter-people", hint: { kind: "tw-handle", value: seg } };
  }

  // Substack
  if (host.endsWith(".substack.com")) {
    const subdomain = host.slice(0, -".substack.com".length);
    return { type: "substack", hint: { kind: "ss-subdomain", value: subdomain } };
  }

  // Direct feed URL
  if (path.endsWith(".xml") || path.endsWith("/feed") || path.endsWith("/rss") || path.endsWith("/feed/") || path.endsWith("/rss/")) {
    return { type: "blog", hint: { kind: "blog-feed", value: u.toString() } };
  }

  // Otherwise: try blog with feed auto-discovery
  return { type: "blog", hint: { kind: "blog-site", value: u.toString() } };
}

// ─── Sources.json read / write ────────────────────────────────────────

function loadSources(): SourcesConfig {
  if (!existsSync(SOURCES_JSON)) return SourcesConfigSchema.parse({});
  const raw = readFileSync(SOURCES_JSON, "utf-8");
  return SourcesConfigSchema.parse(JSON.parse(raw));
}

function saveSources(s: SourcesConfig): void {
  writeFileSync(SOURCES_JSON, JSON.stringify(s, null, 2) + "\n", "utf-8");
}

async function gitCommitPush(messageSubject: string): Promise<void> {
  const env = process.env;
  await exec("git", ["add", SOURCES_JSON], { cwd: CONTEXT_PATH, env });
  await exec("git", [
    "-c", "user.email=mihirkul10@gmail.com",
    "-c", "user.name=Sherlock Agent",
    "commit", "-m", messageSubject,
  ], { cwd: CONTEXT_PATH, env });
  await exec("git", ["push", "origin", "main"], { cwd: CONTEXT_PATH, env });
}

// ─── Main ─────────────────────────────────────────────────────────────

export async function resolveAndAdd(rawUrl: string): Promise<ResolveResult> {
  const t0 = Date.now();
  const u = canonicalize(rawUrl);
  if (!u) return { ok: false, status: "error", message: `Could not parse URL: ${rawUrl}` };
  const classification = classify(u);
  if (!classification) {
    return { ok: false, status: "error", message: `Could not classify URL: ${u.toString()}. Try a direct channel/RSS URL.` };
  }
  log.info({ url: u.toString(), type: classification.type, hint: classification.hint }, "resolving");

  const sources = loadSources();
  const warnings: string[] = [];

  switch (classification.type) {
    case "youtube": {
      const apiKey = requireEnv("YOUTUBE_API_KEY");
      const hint = classification.hint as { kind: "yt-handle" | "yt-channel-id" | "yt-custom"; value: string };
      let resolved = null as null | Awaited<ReturnType<typeof resolveYouTubeByHandle>>;
      if (hint.kind === "yt-handle") {
        resolved = await resolveYouTubeByHandle(hint.value, apiKey);
      } else if (hint.kind === "yt-channel-id") {
        resolved = await resolveYouTubeById(hint.value, apiKey);
      } else {
        resolved = await resolveYouTubeBySearch(hint.value, apiKey);
        if (resolved) warnings.push(`Resolved /c/${hint.value} via search; verify the match.`);
      }
      if (!resolved) {
        return { ok: false, status: "error", message: `YouTube channel could not be resolved (${u.toString()}). Try the canonical /channel/UC… URL.` };
      }
      // Dedupe
      if (sources.youtube.channels.some((c) => c.channelId === resolved.channelId)) {
        return { ok: true, status: "duplicate", type: "youtube", sourceId: resolved.channelId, name: resolved.name, message: `Already tracked: ${resolved.name}` };
      }
      sources.youtube.channels.push({
        channelId: resolved.channelId,
        ...(resolved.handle && { handle: resolved.handle }),
        name: resolved.name,
        checkIntervalMinutes: 30,
      });
      saveSources(sources);
      try { await gitCommitPush(`feat(sources): add youtube ${resolved.name}`); }
      catch (err) { warnings.push(`git push failed: ${err instanceof Error ? err.message : String(err)}`); }
      log.info({ ms: Date.now() - t0, channelId: resolved.channelId, name: resolved.name }, "✓ youtube added");
      return { ok: true, status: "added", type: "youtube", sourceId: resolved.channelId, name: resolved.name, message: `Added YouTube channel: ${resolved.name}`, ...(warnings.length && { warnings }) };
    }

    case "twitter-people": {
      const bearer = requireEnv("TWITTER_BEARER_TOKEN");
      const hint = classification.hint as { kind: "tw-handle"; value: string };
      const resolved = await resolveTwitterByHandle(hint.value, bearer);
      if (!resolved) {
        return { ok: false, status: "error", message: `X user could not be resolved (${u.toString()}). Account may be suspended or private.` };
      }
      if (sources.twitter.people.some((p) => p.userId === resolved.userId)) {
        return { ok: true, status: "duplicate", type: "twitter-people", sourceId: resolved.userId, name: resolved.name, message: `Already tracked: @${resolved.handle}` };
      }
      sources.twitter.people.push({
        handle: resolved.handle,
        userId: resolved.userId,
        name: resolved.name,
        checkIntervalMinutes: 15,
      });
      saveSources(sources);
      try { await gitCommitPush(`feat(sources): add twitter @${resolved.handle}`); }
      catch (err) { warnings.push(`git push failed: ${err instanceof Error ? err.message : String(err)}`); }
      log.info({ ms: Date.now() - t0, userId: resolved.userId, handle: resolved.handle }, "✓ twitter person added");
      return { ok: true, status: "added", type: "twitter-people", sourceId: resolved.userId, name: resolved.name, message: `Added Twitter person: @${resolved.handle} (${resolved.name})`, ...(warnings.length && { warnings }) };
    }

    case "substack": {
      const hint = classification.hint as { kind: "ss-subdomain"; value: string };
      const resolved = await resolveSubstack(hint.value);
      if (!resolved) {
        return { ok: false, status: "error", message: `Substack newsletter could not be resolved (${u.toString()}). Wrong subdomain or paid-only.` };
      }
      if (sources.substack.newsletters.some((n) => n.subdomain === resolved.subdomain)) {
        return { ok: true, status: "duplicate", type: "substack", sourceId: resolved.subdomain, name: resolved.name, message: `Already tracked: ${resolved.name}` };
      }
      sources.substack.newsletters.push({
        subdomain: resolved.subdomain,
        name: resolved.name,
        checkIntervalMinutes: 60,
      });
      saveSources(sources);
      try { await gitCommitPush(`feat(sources): add substack ${resolved.subdomain}`); }
      catch (err) { warnings.push(`git push failed: ${err instanceof Error ? err.message : String(err)}`); }
      log.info({ ms: Date.now() - t0, subdomain: resolved.subdomain, name: resolved.name }, "✓ substack added");
      return { ok: true, status: "added", type: "substack", sourceId: resolved.subdomain, name: resolved.name, message: `Added Substack: ${resolved.name}`, ...(warnings.length && { warnings }) };
    }

    case "blog": {
      const hint = classification.hint as { kind: "blog-feed" | "blog-site"; value: string };
      let feedUrl = hint.value;
      if (hint.kind === "blog-site") {
        const discovered = await discoverFeedUrl(hint.value);
        if (!discovered) {
          return { ok: false, status: "error", message: `Could not auto-discover an RSS/Atom feed at ${hint.value}. Try the direct /feed URL.` };
        }
        feedUrl = discovered;
        warnings.push(`Auto-discovered feed: ${discovered}`);
      }
      const resolved = await resolveBlogFeed(feedUrl);
      if (!resolved) {
        return { ok: false, status: "error", message: `Feed could not be parsed (${feedUrl}).` };
      }
      if (sources.blogs.feeds.some((f) => f.url === resolved.url)) {
        return { ok: true, status: "duplicate", type: "blog", sourceId: resolved.url, name: resolved.name, message: `Already tracked: ${resolved.name}` };
      }
      sources.blogs.feeds.push({
        url: resolved.url,
        name: resolved.name,
        type: resolved.type,
        checkIntervalMinutes: 120,
      });
      saveSources(sources);
      try { await gitCommitPush(`feat(sources): add blog ${resolved.name}`); }
      catch (err) { warnings.push(`git push failed: ${err instanceof Error ? err.message : String(err)}`); }
      log.info({ ms: Date.now() - t0, url: resolved.url, name: resolved.name }, "✓ blog added");
      return { ok: true, status: "added", type: "blog", sourceId: resolved.url, name: resolved.name, message: `Added blog: ${resolved.name}`, ...(warnings.length && { warnings }) };
    }

    default:
      return { ok: false, status: "error", message: `Source type not yet supported: ${classification.type}` };
  }
}

// ─── List + remove (used by the sources MCP) ──────────────────────────

export interface SourcesSummaryRow {
  type: SourceType;
  sourceId: string;
  name: string;
  handle?: string;
  checkIntervalMinutes: number;
}

export function listAllSources(): SourcesSummaryRow[] {
  const s = loadSources();
  const rows: SourcesSummaryRow[] = [];
  for (const c of s.youtube.channels) rows.push({ type: "youtube", sourceId: c.channelId, name: c.name, ...(c.handle && { handle: c.handle }), checkIntervalMinutes: c.checkIntervalMinutes });
  for (const n of s.substack.newsletters) rows.push({ type: "substack", sourceId: n.subdomain, name: n.name, checkIntervalMinutes: n.checkIntervalMinutes });
  for (const p of s.twitter.people) rows.push({ type: "twitter-people", sourceId: p.userId, name: p.name, handle: `@${p.handle}`, checkIntervalMinutes: p.checkIntervalMinutes });
  if (s.twitter.bookmarks) rows.push({ type: "twitter-bookmarks", sourceId: s.twitter.bookmarks.userId, name: `@${s.twitter.bookmarks.handle ?? "?"} bookmarks`, checkIntervalMinutes: s.twitter.bookmarks.checkIntervalMinutes });
  for (const f of s.blogs.feeds) rows.push({ type: "blog", sourceId: f.url, name: f.name, checkIntervalMinutes: f.checkIntervalMinutes });
  return rows;
}

export async function removeSource(type: SourceType, sourceId: string): Promise<{ ok: boolean; message: string }> {
  const s = loadSources();
  let removed = false;
  switch (type) {
    case "youtube":
      s.youtube.channels = s.youtube.channels.filter((c) => c.channelId !== sourceId);
      removed = true; break;
    case "substack":
      s.substack.newsletters = s.substack.newsletters.filter((n) => n.subdomain !== sourceId);
      removed = true; break;
    case "twitter-people":
      s.twitter.people = s.twitter.people.filter((p) => p.userId !== sourceId);
      removed = true; break;
    case "blog":
      s.blogs.feeds = s.blogs.feeds.filter((f) => f.url !== sourceId);
      removed = true; break;
    case "twitter-bookmarks":
      if (s.twitter.bookmarks?.userId === sourceId) {
        delete (s.twitter as { bookmarks?: unknown }).bookmarks;
        removed = true;
      }
      break;
  }
  if (!removed) return { ok: false, message: `No ${type} source with id ${sourceId}` };
  saveSources(s);
  try { await gitCommitPush(`feat(sources): remove ${type} ${sourceId}`); }
  catch (err) { return { ok: true, message: `Removed locally; git push failed: ${err instanceof Error ? err.message : String(err)}` }; }
  return { ok: true, message: `Removed ${type} ${sourceId}` };
}
