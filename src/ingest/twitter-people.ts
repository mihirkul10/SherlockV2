/**
 * Twitter (X) people ingestion pipeline.
 *
 * Discovery + fetch via X API v2 `/2/users/<id>/tweets`. The free / basic tier
 * is *very* rate-limited — caller should pace per-handle calls. We cache the
 * since_id per handle in twitter-people-state.json so we only fetch new tweets.
 *
 * Markdown layout (per plan §3):
 *   sherlock-context/_raw/twitter/people/<handle>/<yyyy-mm-dd>-<tweet-id>.md
 *
 * Frontmatter: source=twitter-people, source_id=<userId>, content_id=<tweetId>,
 * url=https://x.com/<handle>/status/<tweetId>, author=<handle>, published_at,
 * title=first 80 chars of tweet text.
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createLogger } from "../shared/logger.js";
import { stateFilePath, rawDir } from "../shared/paths.js";
import { renderMarkdown, isoDate } from "./markdown.js";

const log = createLogger("ingest:twitter-people");

export interface TwitterPersonState {
  lastTweetId?: string;     // since_id for next fetch
  lastChecked?: string;
  lastError?: string | null;
  knownTweetIds?: string[]; // ring buffer for tighter dedup (last 200)
}

export interface TwitterStateFile {
  [userId: string]: TwitterPersonState;
}

export interface IngestPersonResult {
  userId: string;
  handle: string;
  discovered: number;
  alreadyKnown: number;
  newIngested: number;
  errors: string[];
  durationMs: number;
}

interface XTweet {
  id: string;
  text: string;
  created_at: string;     // ISO
  author_id?: string;
  conversation_id?: string;
  referenced_tweets?: Array<{ type: "retweeted" | "replied_to" | "quoted"; id: string }>;
}

const KNOWN_RING = 200;

function loadState(): TwitterStateFile {
  const path = stateFilePath("twitter-people");
  if (!existsSync(path)) return {};
  try { return JSON.parse(readFileSync(path, "utf-8")) as TwitterStateFile; } catch { return {}; }
}

function saveState(state: TwitterStateFile): void {
  const path = stateFilePath("twitter-people");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n", "utf-8");
}

function pushKnown(state: TwitterPersonState, id: string): void {
  const known = state.knownTweetIds ?? [];
  if (known.includes(id)) return;
  known.push(id);
  if (known.length > KNOWN_RING) known.splice(0, known.length - KNOWN_RING);
  state.knownTweetIds = known;
}

async function fetchRecentTweets(opts: {
  userId: string;
  bearer: string;
  sinceId?: string;
  maxResults?: number;
}): Promise<XTweet[]> {
  const params = new URLSearchParams({
    "max_results": String(Math.max(5, Math.min(opts.maxResults ?? 25, 100))),
    "tweet.fields": "created_at,author_id,conversation_id,referenced_tweets",
    "exclude": "retweets,replies", // focus on original posts; cheaper to ingest
  });
  if (opts.sinceId) params.set("since_id", opts.sinceId);
  const url = `https://api.x.com/2/users/${encodeURIComponent(opts.userId)}/tweets?${params.toString()}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${opts.bearer}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 429) {
    const reset = res.headers.get("x-rate-limit-reset");
    throw new Error(`X API rate-limited (429). Reset at ${reset}`);
  }
  if (!res.ok) {
    throw new Error(`X API HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = await res.json() as { data?: XTweet[]; meta?: { result_count: number; newest_id?: string } };
  return data.data ?? [];
}

function tweetTitle(text: string): string {
  // First non-empty line, max ~80 chars
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 80 ? oneLine.slice(0, 77) + "…" : oneLine;
}

function writeTweetMarkdown(opts: {
  tweet: XTweet;
  userId: string;
  handle: string;
  authorName: string;
}): string {
  const dir = rawDir("twitter/people", opts.handle.toLowerCase());
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, `${isoDate(opts.tweet.created_at)}-${opts.tweet.id}.md`);
  const md = renderMarkdown({
    source: "twitter-people",
    source_id: opts.userId,
    content_id: opts.tweet.id,
    url: `https://x.com/${opts.handle}/status/${opts.tweet.id}`,
    author: opts.authorName,
    published_at: opts.tweet.created_at,
    title: tweetTitle(opts.tweet.text),
    body: opts.tweet.text,
    extras: {
      handle: `@${opts.handle}`,
      ...(opts.tweet.conversation_id && { conversation_id: opts.tweet.conversation_id }),
    },
  });
  writeFileSync(path, md, "utf-8");
  return path;
}

export interface IngestPersonOptions {
  userId: string;
  handle: string;
  authorName: string;
  bearer: string;
  /** First-time backfill cap (defaults 50; subsequent runs use sinceId). */
  initialBackfill?: number;
}

export async function ingestTwitterPerson(opts: IngestPersonOptions): Promise<IngestPersonResult> {
  const t0 = Date.now();
  const errors: string[] = [];
  log.info({ userId: opts.userId, handle: opts.handle }, "starting person ingest");

  const state = loadState();
  const personState: TwitterPersonState = state[opts.userId] ?? {};
  const known = new Set(personState.knownTweetIds ?? []);

  let tweets: XTweet[];
  try {
    tweets = await fetchRecentTweets({
      userId: opts.userId,
      bearer: opts.bearer,
      ...(personState.lastTweetId && { sinceId: personState.lastTweetId }),
      maxResults: personState.lastTweetId ? 25 : (opts.initialBackfill ?? 50),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ userId: opts.userId, handle: opts.handle, err: msg }, "X fetch failed");
    return {
      userId: opts.userId,
      handle: opts.handle,
      discovered: 0,
      alreadyKnown: 0,
      newIngested: 0,
      errors: [`fetch: ${msg}`],
      durationMs: Date.now() - t0,
    };
  }

  const fresh = tweets.filter((t) => !known.has(t.id));
  log.info({ handle: opts.handle, discovered: tweets.length, fresh: fresh.length }, "discovery complete");

  let newIngested = 0;
  for (const t of fresh) {
    try {
      writeTweetMarkdown({
        tweet: t,
        userId: opts.userId,
        handle: opts.handle,
        authorName: opts.authorName,
      });
      pushKnown(personState, t.id);
      newIngested++;
    } catch (err) {
      errors.push(`${t.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (fresh.length > 0) {
    // Tweets come newest-first; lastTweetId tracks the highest id we've seen
    personState.lastTweetId = tweets[0]?.id ?? personState.lastTweetId;
  }
  personState.lastChecked = new Date().toISOString();
  personState.lastError = errors.length > 0 ? errors[0]! : null;
  state[opts.userId] = personState;
  saveState(state);

  return {
    userId: opts.userId,
    handle: opts.handle,
    discovered: tweets.length,
    alreadyKnown: tweets.length - fresh.length,
    newIngested,
    errors,
    durationMs: Date.now() - t0,
  };
}
