/**
 * Substack ingestion pipeline.
 *
 * Discovery + content via the public RSS feed at <subdomain>.substack.com/feed
 * (no auth required for public posts; member-only posts would need the
 * substack.sid cookie — TBD per plan §13).
 *
 * Markdown layout: sherlock-context/_raw/substack/<subdomain>/<yyyy-mm-dd>-<slug>.md
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createLogger } from "../shared/logger.js";
import { stateFilePath, rawDir } from "../shared/paths.js";
import { renderMarkdown, slugify, isoDate } from "./markdown.js";

const log = createLogger("ingest:substack");

export interface SubstackState {
  lastPostGuid?: string;
  lastChecked?: string;
  lastError?: string | null;
  knownPostGuids?: string[];
}

export interface SubstackStateFile {
  [subdomain: string]: SubstackState;
}

interface SubstackPost {
  guid: string;
  title: string;
  link: string;
  pubDate: string;
  description: string;
  contentEncoded?: string;
  creator?: string;
}

const KNOWN_RING = 200;

function loadState(): SubstackStateFile {
  const p = stateFilePath("substack");
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return {}; }
}

function saveState(s: SubstackStateFile): void {
  const p = stateFilePath("substack");
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(s, null, 2) + "\n", "utf-8");
}

function pushKnown(state: SubstackState, guid: string): void {
  const known = state.knownPostGuids ?? [];
  if (known.includes(guid)) return;
  known.push(guid);
  if (known.length > KNOWN_RING) known.splice(0, known.length - KNOWN_RING);
  state.knownPostGuids = known;
}

// ─── RSS parser (regex-based; same approach as the YouTube path) ──────

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
  // Cheap: strip tags + collapse whitespace. Keeps paragraph breaks.
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function parseRssFeed(xml: string): SubstackPost[] {
  const items: SubstackPost[] = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  for (const m of xml.matchAll(itemRe)) {
    const item = m[1]!;
    const guid = extractTag(item, "guid") || extractTag(item, "link");
    const title = extractTag(item, "title");
    const link = extractTag(item, "link");
    const pubDate = extractTag(item, "pubDate");
    const description = extractTag(item, "description");
    const contentEncoded = extractTag(item, "content:encoded");
    const creator = extractTag(item, "dc:creator");
    if (guid && title && link) {
      items.push({
        guid,
        title,
        link,
        pubDate: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
        description,
        contentEncoded,
        ...(creator && { creator }),
      });
    }
  }
  return items;
}

async function discoverNewPosts(subdomain: string): Promise<SubstackPost[]> {
  const url = `https://${subdomain}.substack.com/feed`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`feed fetch HTTP ${res.status}`);
  return parseRssFeed(await res.text());
}

function postSlug(post: SubstackPost): string {
  // Prefer the URL's terminal segment if it's a sane slug, else slugify the title.
  try {
    const u = new URL(post.link);
    const last = u.pathname.split("/").filter(Boolean).pop() ?? "";
    if (last && /^[\w-]+$/.test(last)) return slugify(last, 80);
  } catch { /* ignore */ }
  return slugify(post.title, 80);
}

function writePostMarkdown(opts: {
  post: SubstackPost;
  subdomain: string;
  newsletterName: string;
}): string {
  const dir = rawDir("substack", opts.subdomain);
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, `${isoDate(opts.post.pubDate)}-${postSlug(opts.post)}.md`);
  const body = htmlToText(opts.post.contentEncoded || opts.post.description);
  const md = renderMarkdown({
    source: "substack",
    source_id: opts.subdomain,
    content_id: opts.post.guid,
    url: opts.post.link,
    author: opts.post.creator || opts.newsletterName,
    published_at: opts.post.pubDate,
    title: opts.post.title,
    body,
    extras: { newsletter: opts.newsletterName },
  });
  writeFileSync(path, md, "utf-8");
  return path;
}

export interface IngestSubstackResult {
  subdomain: string;
  newsletterName: string;
  discovered: number;
  alreadyKnown: number;
  newIngested: number;
  errors: string[];
  durationMs: number;
}

export interface IngestSubstackOptions {
  subdomain: string;
  newsletterName: string;
  maxNewPerRun?: number;
}

export async function ingestSubstackNewsletter(opts: IngestSubstackOptions): Promise<IngestSubstackResult> {
  const t0 = Date.now();
  const errors: string[] = [];
  log.info({ subdomain: opts.subdomain, name: opts.newsletterName }, "starting newsletter ingest");

  let posts: SubstackPost[];
  try {
    posts = await discoverNewPosts(opts.subdomain);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ subdomain: opts.subdomain, err: msg }, "feed fetch failed");
    return {
      subdomain: opts.subdomain,
      newsletterName: opts.newsletterName,
      discovered: 0,
      alreadyKnown: 0,
      newIngested: 0,
      errors: [`fetch: ${msg}`],
      durationMs: Date.now() - t0,
    };
  }

  const state = loadState();
  const ns = state[opts.subdomain] ?? {};
  const known = new Set(ns.knownPostGuids ?? []);
  const fresh = posts.filter((p) => !known.has(p.guid)).slice(0, opts.maxNewPerRun ?? 30);

  log.info({ subdomain: opts.subdomain, discovered: posts.length, fresh: fresh.length }, "discovery complete");

  let newIngested = 0;
  for (const post of fresh) {
    try {
      writePostMarkdown({ post, subdomain: opts.subdomain, newsletterName: opts.newsletterName });
      pushKnown(ns, post.guid);
      newIngested++;
    } catch (err) {
      errors.push(`${post.guid}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  ns.lastChecked = new Date().toISOString();
  if (fresh.length > 0) ns.lastPostGuid = fresh[0]?.guid ?? ns.lastPostGuid;
  ns.lastError = errors.length > 0 ? errors[0]! : null;
  state[opts.subdomain] = ns;
  saveState(state);

  return {
    subdomain: opts.subdomain,
    newsletterName: opts.newsletterName,
    discovered: posts.length,
    alreadyKnown: posts.length - fresh.length,
    newIngested,
    errors,
    durationMs: Date.now() - t0,
  };
}
