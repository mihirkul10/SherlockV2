/**
 * One-shot ingestion CLI used by both:
 *   - Cursor Cloud Automation prompts (e.g. `tsx src/scripts/ingest-once.ts youtube`)
 *   - Local testing / backfill / Admin Canvas force-run
 *
 * Modes:
 *   ingest-once.ts youtube                      → all 29 channels from sources.json
 *   ingest-once.ts youtube <channelId>          → just one channel by UC id
 *   ingest-once.ts youtube --handle @stripe     → just one channel by @handle
 *   ingest-once.ts substack                     → (M4)
 *   ingest-once.ts twitter-people               → (M3)
 *   ingest-once.ts twitter-bookmarks            → (M4)
 *   ingest-once.ts blog                         → (M4)
 *
 * Appends a single ndjson line per run to sherlock-context/_runs/ingest-runs.ndjson
 * for Admin Canvas history.
 */

import { existsSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { nanoid } from "nanoid";
import { loadEnv } from "../shared/env.js";
import { createLogger } from "../shared/logger.js";
import { SOURCES_JSON, CONTEXT_RUNS_LOG } from "../shared/paths.js";
import { SourcesConfigSchema } from "../shared/sources-schema.js";
import { ingestYouTubeChannel, type IngestSummary } from "../ingest/youtube.js";
import { ingestTwitterPerson, type IngestPersonResult } from "../ingest/twitter-people.js";
import { ingestSubstackNewsletter, type IngestSubstackResult } from "../ingest/substack.js";
import { ingestBlogFeed, type IngestBlogResult } from "../ingest/blogs.js";
import { requireEnv } from "../shared/env.js";

const log = createLogger("ingest-once");

interface RunLogEntry {
  runId: string;
  source: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  channelsProcessed: number;
  newItems: number;
  errors: number;
  status: "ok" | "partial" | "error";
  selector?: string;
}

function appendRunLog(entry: RunLogEntry): void {
  mkdirSync(dirname(CONTEXT_RUNS_LOG), { recursive: true });
  appendFileSync(CONTEXT_RUNS_LOG, JSON.stringify(entry) + "\n", "utf-8");
}

function loadSources() {
  if (!existsSync(SOURCES_JSON)) {
    throw new Error(`${SOURCES_JSON} not found. Run M0g (seed-sources) first.`);
  }
  return SourcesConfigSchema.parse(JSON.parse(readFileSync(SOURCES_JSON, "utf-8")));
}

async function ingestYouTube(selectorChannelId: string | undefined, selectorHandle: string | undefined) {
  const sources = loadSources();
  let channels = sources.youtube.channels;
  if (selectorChannelId) {
    channels = channels.filter((c) => c.channelId === selectorChannelId);
    if (channels.length === 0) throw new Error(`No YouTube channel with id=${selectorChannelId} in sources.json`);
  } else if (selectorHandle) {
    const wanted = selectorHandle.startsWith("@") ? selectorHandle.toLowerCase() : `@${selectorHandle.toLowerCase()}`;
    channels = channels.filter((c) => (c.handle ?? "").toLowerCase() === wanted);
    if (channels.length === 0) throw new Error(`No YouTube channel with handle=${selectorHandle} in sources.json`);
  }

  log.info({ channelCount: channels.length }, "youtube ingest starting");
  const summaries: IngestSummary[] = [];
  for (const channel of channels) {
    try {
      const summary = await ingestYouTubeChannel({
        channelId: channel.channelId,
        channelName: channel.name,
        ...(channel.handle && { channelHandle: channel.handle }),
      });
      summaries.push(summary);
    } catch (err) {
      log.error(
        { channelId: channel.channelId, error: err instanceof Error ? err.message : String(err) },
        "channel ingest threw"
      );
      summaries.push({
        channelId: channel.channelId,
        channelName: channel.name,
        discovered: 0,
        alreadyKnown: 0,
        newWithTranscript: 0,
        newWithoutTranscript: 0,
        errors: [err instanceof Error ? err.message : String(err)],
        durationMs: 0,
      });
    }
  }
  return summaries;
}

interface AnyIngestSummary {
  unitId: string;        // channelId, userId, subdomain, feedUrl
  unitName: string;
  newItems: number;
  errors: string[];
  durationMs: number;
}

function asYouTubeSummary(s: IngestSummary): AnyIngestSummary {
  return { unitId: s.channelId, unitName: s.channelName, newItems: s.newWithTranscript + s.newWithoutTranscript, errors: s.errors, durationMs: s.durationMs };
}
function asTwitterSummary(s: IngestPersonResult): AnyIngestSummary {
  return { unitId: s.userId, unitName: `@${s.handle}`, newItems: s.newIngested, errors: s.errors, durationMs: s.durationMs };
}
function asSubstackSummary(s: IngestSubstackResult): AnyIngestSummary {
  return { unitId: s.subdomain, unitName: s.newsletterName, newItems: s.newIngested, errors: s.errors, durationMs: s.durationMs };
}
function asBlogSummary(s: IngestBlogResult): AnyIngestSummary {
  return { unitId: s.feedUrl, unitName: s.feedName, newItems: s.newIngested, errors: s.errors, durationMs: s.durationMs };
}

async function ingestTwitterPeople(selectorUserId: string | undefined, selectorHandle: string | undefined): Promise<AnyIngestSummary[]> {
  const sources = loadSources();
  let people = sources.twitter.people;
  if (selectorUserId) people = people.filter((p) => p.userId === selectorUserId);
  if (selectorHandle) {
    const wanted = selectorHandle.replace(/^@/, "").toLowerCase();
    people = people.filter((p) => p.handle.toLowerCase() === wanted);
  }
  if (people.length === 0) {
    log.warn("no twitter people to ingest (sources.json has 0 or selector matched none)");
    return [];
  }
  const bearer = requireEnv("TWITTER_BEARER_TOKEN");
  const out: AnyIngestSummary[] = [];
  for (const person of people) {
    try {
      const result = await ingestTwitterPerson({
        userId: person.userId,
        handle: person.handle,
        authorName: person.name,
        bearer,
      });
      out.push(asTwitterSummary(result));
      // Aggressive pacing — X free tier rate limits (~1 user-tweets call per ~30s).
      await new Promise((r) => setTimeout(r, 30_000));
    } catch (err) {
      out.push({ unitId: person.userId, unitName: `@${person.handle}`, newItems: 0, errors: [err instanceof Error ? err.message : String(err)], durationMs: 0 });
    }
  }
  return out;
}

async function ingestSubstack(selectorSubdomain: string | undefined): Promise<AnyIngestSummary[]> {
  const sources = loadSources();
  let newsletters = sources.substack.newsletters;
  if (selectorSubdomain) newsletters = newsletters.filter((n) => n.subdomain === selectorSubdomain);
  if (newsletters.length === 0) {
    log.info("no substack newsletters configured (add via sources.add or seed sources.json)");
    return [];
  }
  const out: AnyIngestSummary[] = [];
  for (const n of newsletters) {
    try {
      const result = await ingestSubstackNewsletter({ subdomain: n.subdomain, newsletterName: n.name });
      out.push(asSubstackSummary(result));
    } catch (err) {
      out.push({ unitId: n.subdomain, unitName: n.name, newItems: 0, errors: [err instanceof Error ? err.message : String(err)], durationMs: 0 });
    }
  }
  return out;
}

async function ingestBlogs(selectorFeedUrl: string | undefined): Promise<AnyIngestSummary[]> {
  const sources = loadSources();
  let feeds = sources.blogs.feeds;
  if (selectorFeedUrl) feeds = feeds.filter((f) => f.url === selectorFeedUrl);
  if (feeds.length === 0) {
    log.info("no blog feeds configured (add via sources.add)");
    return [];
  }
  const out: AnyIngestSummary[] = [];
  for (const f of feeds) {
    try {
      const result = await ingestBlogFeed({ feedUrl: f.url, feedName: f.name, feedType: f.type === "atom" ? "atom" : "rss" });
      out.push(asBlogSummary(result));
    } catch (err) {
      out.push({ unitId: f.url, unitName: f.name, newItems: 0, errors: [err instanceof Error ? err.message : String(err)], durationMs: 0 });
    }
  }
  return out;
}

async function main(): Promise<number> {
  loadEnv();
  const args = process.argv.slice(2);
  const source = args[0];
  if (!source) {
    log.error("Usage: ingest-once.ts <source> [<id>] [--handle @x]");
    log.error("Sources: youtube, substack, twitter-people, blog");
    return 2;
  }

  const handleIdx = args.indexOf("--handle");
  const selectorHandle = handleIdx >= 0 ? args[handleIdx + 1] : undefined;
  const selectorId = args[1] && args[1] !== "--handle" ? args[1] : undefined;
  const selector = selectorId ?? selectorHandle;

  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const runId = nanoid(10);
  log.info({ runId, source, selector }, "ingest-once start");

  let summaries: AnyIngestSummary[];
  try {
    if (source === "youtube") {
      const s = await ingestYouTube(selectorId, selectorHandle);
      summaries = s.map(asYouTubeSummary);
    } else if (source === "twitter-people") {
      summaries = await ingestTwitterPeople(selectorId, selectorHandle);
    } else if (source === "substack") {
      summaries = await ingestSubstack(selectorId);
    } else if (source === "blog" || source === "blogs") {
      summaries = await ingestBlogs(selectorId);
    } else {
      log.error({ source }, "source not yet supported (twitter-bookmarks deferred to M4+1 due to OAuth requirement)");
      return 2;
    }
  } catch (err) {
    log.fatal({ err: err instanceof Error ? err.message : String(err) }, "ingest crashed");
    appendRunLog({
      runId,
      source,
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - t0,
      channelsProcessed: 0,
      newItems: 0,
      errors: 1,
      status: "error",
      ...(selector && { selector }),
    });
    return 1;
  }

  const totalNew = summaries.reduce((sum, s) => sum + s.newItems, 0);
  const totalErrors = summaries.reduce((sum, s) => sum + s.errors.length, 0);
  const status: "ok" | "partial" | "error" = totalErrors === 0 ? "ok" : (totalNew > 0 ? "partial" : "error");

  appendRunLog({
    runId,
    source,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - t0,
    channelsProcessed: summaries.length,
    newItems: totalNew,
    errors: totalErrors,
    status,
    ...(selector && { selector }),
  });

  log.info({ runId, summaries: summaries.length, totalNew, totalErrors, status, ms: Date.now() - t0 }, "✓ ingest-once complete");
  return status === "error" ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    log.fatal({ err: err instanceof Error ? err.message : String(err) }, "ingest-once crashed at top");
    process.exit(2);
  });
