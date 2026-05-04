/**
 * Generic blog (RSS / Atom) ingestion pipeline.
 *
 * Discovery + content via the feed URL. We support both RSS 2.0 and Atom
 * (the feed type was already determined by resolveBlogFeed at add-time).
 *
 * Markdown layout: sherlock-context/_raw/blogs/<host>/<yyyy-mm-dd>-<slug>.md
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createLogger } from "../shared/logger.js";
import { stateFilePath, rawDir } from "../shared/paths.js";
import { renderMarkdown, slugify, isoDate } from "./markdown.js";

const log = createLogger("ingest:blogs");

export interface BlogState {
  lastEntryId?: string;
  lastChecked?: string;
  lastError?: string | null;
  knownEntryIds?: string[];
}

export interface BlogStateFile {
  [feedUrl: string]: BlogState;
}

interface BlogEntry {
  id: string;
  title: string;
  link: string;
  published: string;
  author?: string;
  body: string;
}

const KNOWN_RING = 200;

function loadState(): BlogStateFile {
  const p = stateFilePath("blogs");
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return {}; }
}

function saveState(s: BlogStateFile): void {
  const p = stateFilePath("blogs");
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(s, null, 2) + "\n", "utf-8");
}

function pushKnown(state: BlogState, id: string): void {
  const known = state.knownEntryIds ?? [];
  if (known.includes(id)) return;
  known.push(id);
  if (known.length > KNOWN_RING) known.splice(0, known.length - KNOWN_RING);
  state.knownEntryIds = known;
}

function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function extractTag(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  return decodeXml(re.exec(xml)?.[1]?.trim() ?? "");
}

function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function parseFeed(xml: string, isAtom: boolean): BlogEntry[] {
  const entries: BlogEntry[] = [];
  if (isAtom) {
    const re = /<entry>([\s\S]*?)<\/entry>/g;
    for (const m of xml.matchAll(re)) {
      const e = m[1]!;
      const id = extractTag(e, "id");
      const title = extractTag(e, "title");
      const linkMatch = e.match(/<link[^>]+href=["']([^"']+)["']/);
      const link = linkMatch?.[1] ?? "";
      const updated = extractTag(e, "updated") || extractTag(e, "published");
      const author = extractTag(e, "name") || extractTag(e, "author");
      const content = extractTag(e, "content") || extractTag(e, "summary");
      if (id && title && link) {
        entries.push({
          id,
          title,
          link,
          published: updated ? new Date(updated).toISOString() : new Date().toISOString(),
          ...(author && { author }),
          body: htmlToText(content),
        });
      }
    }
  } else {
    const re = /<item>([\s\S]*?)<\/item>/g;
    for (const m of xml.matchAll(re)) {
      const item = m[1]!;
      const id = extractTag(item, "guid") || extractTag(item, "link");
      const title = extractTag(item, "title");
      const link = extractTag(item, "link");
      const pubDate = extractTag(item, "pubDate");
      const author = extractTag(item, "dc:creator") || extractTag(item, "author");
      const content = extractTag(item, "content:encoded") || extractTag(item, "description");
      if (id && title && link) {
        entries.push({
          id,
          title,
          link,
          published: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
          ...(author && { author }),
          body: htmlToText(content),
        });
      }
    }
  }
  return entries;
}

function entrySlug(entry: BlogEntry): string {
  try {
    const u = new URL(entry.link);
    const last = u.pathname.split("/").filter(Boolean).pop() ?? "";
    if (last && last.length > 3 && /^[\w-]+$/.test(last)) return slugify(last, 80);
  } catch { /* ignore */ }
  return slugify(entry.title, 80);
}

function hostFromUrl(s: string): string {
  try { return new URL(s).hostname.replace(/^www\./, ""); } catch { return "unknown"; }
}

function writeEntryMarkdown(opts: {
  entry: BlogEntry;
  feedUrl: string;
  feedName: string;
}): string {
  const host = hostFromUrl(opts.entry.link || opts.feedUrl);
  const dir = rawDir("blogs", host);
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, `${isoDate(opts.entry.published)}-${entrySlug(opts.entry)}.md`);
  const md = renderMarkdown({
    source: "blog",
    source_id: opts.feedUrl,
    content_id: opts.entry.id,
    url: opts.entry.link,
    author: opts.entry.author || opts.feedName,
    published_at: opts.entry.published,
    title: opts.entry.title,
    body: opts.entry.body,
    extras: { feed_name: opts.feedName, host },
  });
  writeFileSync(path, md, "utf-8");
  return path;
}

export interface IngestBlogResult {
  feedUrl: string;
  feedName: string;
  discovered: number;
  alreadyKnown: number;
  newIngested: number;
  errors: string[];
  durationMs: number;
}

export interface IngestBlogOptions {
  feedUrl: string;
  feedName: string;
  feedType: "rss" | "atom";
  maxNewPerRun?: number;
}

export async function ingestBlogFeed(opts: IngestBlogOptions): Promise<IngestBlogResult> {
  const t0 = Date.now();
  const errors: string[] = [];
  log.info({ feedUrl: opts.feedUrl, feedType: opts.feedType }, "starting blog ingest");

  let entries: BlogEntry[];
  try {
    const res = await fetch(opts.feedUrl, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`feed HTTP ${res.status}`);
    entries = parseFeed(await res.text(), opts.feedType === "atom");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ feedUrl: opts.feedUrl, err: msg }, "feed fetch failed");
    return {
      feedUrl: opts.feedUrl,
      feedName: opts.feedName,
      discovered: 0,
      alreadyKnown: 0,
      newIngested: 0,
      errors: [`fetch: ${msg}`],
      durationMs: Date.now() - t0,
    };
  }

  const state = loadState();
  const fs = state[opts.feedUrl] ?? {};
  const known = new Set(fs.knownEntryIds ?? []);
  const fresh = entries.filter((e) => !known.has(e.id)).slice(0, opts.maxNewPerRun ?? 30);

  log.info({ feedUrl: opts.feedUrl, discovered: entries.length, fresh: fresh.length }, "discovery complete");

  let newIngested = 0;
  for (const entry of fresh) {
    try {
      writeEntryMarkdown({ entry, feedUrl: opts.feedUrl, feedName: opts.feedName });
      pushKnown(fs, entry.id);
      newIngested++;
    } catch (err) {
      errors.push(`${entry.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  fs.lastChecked = new Date().toISOString();
  if (fresh.length > 0) fs.lastEntryId = fresh[0]?.id ?? fs.lastEntryId;
  fs.lastError = errors.length > 0 ? errors[0]! : null;
  state[opts.feedUrl] = fs;
  saveState(state);

  return {
    feedUrl: opts.feedUrl,
    feedName: opts.feedName,
    discovered: entries.length,
    alreadyKnown: entries.length - fresh.length,
    newIngested,
    errors,
    durationMs: Date.now() - t0,
  };
}
