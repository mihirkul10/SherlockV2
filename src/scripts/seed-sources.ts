/**
 * Seeds sherlock-context/_state/sources.json with the SherlockV2 MVP roster.
 *
 * Pipeline:
 *   1. Run resolve-youtube-handles.ts in-process → 29 channelIds.
 *   2. Run resolve-twitter-handles.ts in-process → 4 userIds + me userId.
 *   3. Compose the SourcesConfig per shared/sources-schema.ts.
 *   4. Validate via zod.
 *   5. Write to sherlock-context/_state/sources.json.
 *   6. Initialize empty per-source state files (youtube-state.json, etc.).
 *   7. Initialize an empty _runs/ingest-runs.ndjson.
 *
 * Idempotent: re-running merges new resolved entries with whatever's already
 * in sources.json (keyed by canonical id), so manual additions survive.
 *
 * Usage: npm run seed:sources
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  SourcesConfigSchema,
  type SourcesConfig,
  type YouTubeChannel,
  type TwitterPerson,
} from "../shared/sources-schema.js";
import {
  CONTEXT_PATH,
  CONTEXT_STATE_DIR,
  CONTEXT_RUNS_LOG,
  SOURCES_JSON,
  stateFilePath,
} from "../shared/paths.js";
import { loadEnv, requireEnv } from "../shared/env.js";
import { createLogger } from "../shared/logger.js";
import { SEED_HANDLES } from "./resolve-youtube-handles.js";
import { SEED_PEOPLE, ME_HANDLE } from "./resolve-twitter-handles.js";

const log = createLogger("seed:sources");

interface YTResolved { handle: string; channelId: string; name: string }
interface TwUser { handle: string; userId: string; name: string }

async function resolveYouTube(apiKey: string): Promise<YTResolved[]> {
  log.info("Resolving %d YouTube handles…", SEED_HANDLES.length);
  const out: YTResolved[] = [];
  const failures: string[] = [];
  for (const handle of SEED_HANDLES) {
    const cleanHandle = handle.startsWith("@") ? handle.slice(1) : handle;
    const url =
      `https://www.googleapis.com/youtube/v3/channels` +
      `?part=snippet&forHandle=${encodeURIComponent(cleanHandle)}&key=${apiKey}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) {
        failures.push(`${handle} (HTTP ${res.status})`);
        continue;
      }
      const data = await res.json() as { items?: Array<{ id: string; snippet: { title: string } }> };
      const item = data.items?.[0];
      if (!item) {
        failures.push(`${handle} (no items returned)`);
        continue;
      }
      out.push({ handle, channelId: item.id, name: item.snippet.title });
      log.info({ handle, channelId: item.id, name: item.snippet.title }, "✓");
    } catch (err) {
      failures.push(`${handle} (${err instanceof Error ? err.message : String(err)})`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (failures.length > 0) {
    throw new Error(`YouTube resolution failed for: ${failures.join(", ")}`);
  }
  return out;
}

async function resolveTwitter(bearer: string): Promise<{ people: TwUser[]; me: TwUser }> {
  log.info("Resolving Twitter handles…");
  async function one(handle: string, fallbackName?: string): Promise<TwUser | null> {
    const url = `https://api.x.com/2/users/by/username/${encodeURIComponent(handle)}?user.fields=name`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${bearer}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 429) {
      log.warn({ handle }, "rate limited; sleeping 60s");
      await new Promise((r) => setTimeout(r, 60_000));
      return one(handle, fallbackName);
    }
    if (!res.ok) return null;
    const data = await res.json() as { data?: { id: string; name: string; username: string } };
    if (!data.data) return null;
    return { handle: data.data.username, userId: data.data.id, name: data.data.name || fallbackName || handle };
  }

  const people: TwUser[] = [];
  for (const seed of SEED_PEOPLE) {
    const r = await one(seed.handle, seed.fallbackName);
    if (!r) throw new Error(`Twitter resolution failed for @${seed.handle}`);
    people.push(r);
    log.info({ handle: r.handle, userId: r.userId, name: r.name }, "✓");
    await new Promise((r) => setTimeout(r, 1500));
  }

  const me = await one(ME_HANDLE, "Mihir Kulkarni");
  if (!me) throw new Error(`Twitter resolution failed for @${ME_HANDLE}`);
  log.info({ handle: me.handle, userId: me.userId }, "✓ me (for bookmarks)");
  return { people, me };
}

function loadExistingOrEmpty(): SourcesConfig {
  if (existsSync(SOURCES_JSON)) {
    try {
      const raw = readFileSync(SOURCES_JSON, "utf-8");
      return SourcesConfigSchema.parse(JSON.parse(raw));
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "Existing sources.json couldn't parse — starting fresh"
      );
    }
  }
  return SourcesConfigSchema.parse({});
}

function mergeYouTube(existing: YouTubeChannel[], resolved: YTResolved[]): YouTubeChannel[] {
  const byId = new Map<string, YouTubeChannel>();
  for (const ch of existing) byId.set(ch.channelId, ch);
  for (const r of resolved) {
    const prev = byId.get(r.channelId);
    byId.set(r.channelId, {
      channelId: r.channelId,
      handle: r.handle,
      name: r.name,
      checkIntervalMinutes: prev?.checkIntervalMinutes ?? 30,
    });
  }
  return [...byId.values()];
}

function mergeTwitterPeople(existing: TwitterPerson[], resolved: TwUser[]): TwitterPerson[] {
  const byId = new Map<string, TwitterPerson>();
  for (const p of existing) byId.set(p.userId, p);
  for (const r of resolved) {
    const prev = byId.get(r.userId);
    byId.set(r.userId, {
      handle: r.handle,
      userId: r.userId,
      name: r.name,
      checkIntervalMinutes: prev?.checkIntervalMinutes ?? 15,
    });
  }
  return [...byId.values()];
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function writeIfMissing(path: string, contents: string): boolean {
  ensureDir(dirname(path));
  if (existsSync(path)) return false;
  writeFileSync(path, contents, "utf-8");
  return true;
}

async function main(): Promise<void> {
  loadEnv();
  const ytKey = requireEnv("YOUTUBE_API_KEY");
  const twBearer = requireEnv("TWITTER_BEARER_TOKEN");

  if (!existsSync(CONTEXT_PATH)) {
    throw new Error(
      `${CONTEXT_PATH} does not exist. Run M0f (create + clone sherlock-context repo) before seeding.`
    );
  }

  const yt = await resolveYouTube(ytKey);
  const tw = await resolveTwitter(twBearer);

  const existing = loadExistingOrEmpty();
  const merged: SourcesConfig = {
    youtube: { channels: mergeYouTube(existing.youtube.channels, yt) },
    substack: { newsletters: existing.substack.newsletters }, // [FILL] later
    twitter: {
      people: mergeTwitterPeople(existing.twitter.people, tw.people),
      bookmarks: { userId: tw.me.userId, handle: tw.me.handle, checkIntervalMinutes: 30 },
    },
    blogs: { feeds: existing.blogs.feeds },
  };

  // Validate via zod before writing.
  const validated = SourcesConfigSchema.parse(merged);

  ensureDir(CONTEXT_STATE_DIR);
  writeFileSync(SOURCES_JSON, JSON.stringify(validated, null, 2) + "\n", "utf-8");
  log.info({ path: SOURCES_JSON }, "✓ wrote sources.json");

  // Initialize empty state files for each source-type.
  for (const sourceType of ["youtube", "substack", "twitter-people", "twitter-bookmarks", "blogs"] as const) {
    const path = stateFilePath(sourceType);
    const created = writeIfMissing(path, JSON.stringify({}, null, 2) + "\n");
    log.info({ path, created }, created ? "✓ initialized" : "= already exists");
  }

  // Initialize empty runs log.
  const runsCreated = writeIfMissing(CONTEXT_RUNS_LOG, "");
  log.info({ path: CONTEXT_RUNS_LOG, created: runsCreated }, runsCreated ? "✓ initialized" : "= already exists");

  // Summary.
  log.info(
    {
      youtube: validated.youtube.channels.length,
      substack: validated.substack.newsletters.length,
      twitter_people: validated.twitter.people.length,
      twitter_bookmarks_user: validated.twitter.bookmarks?.handle,
      blogs: validated.blogs.feeds.length,
    },
    "✓ Seed complete"
  );
}

main().catch((err) => {
  log.fatal({ err: err instanceof Error ? err.message : String(err) }, "crashed");
  process.exit(1);
});
