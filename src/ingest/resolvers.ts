/**
 * Per-source identifier resolvers.
 *
 * Both the seed scripts (resolve-youtube-handles.ts, resolve-twitter-handles.ts)
 * and the URL resolver (shared/url-resolver.ts) call into these. Single source
 * of truth for "given this kind of identifier, what's the canonical id?".
 */

import { createLogger } from "../shared/logger.js";

const log = createLogger("ingest:resolvers");

// ─── YouTube ──────────────────────────────────────────────────────────

export interface ResolvedYouTubeChannel {
  channelId: string;
  handle?: string;
  name: string;
}

/** Resolve a YouTube @handle (with or without leading @) to its canonical UC id. */
export async function resolveYouTubeByHandle(
  handle: string,
  apiKey: string,
): Promise<ResolvedYouTubeChannel | null> {
  const cleanHandle = handle.startsWith("@") ? handle.slice(1) : handle;
  const url =
    `https://www.googleapis.com/youtube/v3/channels` +
    `?part=snippet&forHandle=${encodeURIComponent(cleanHandle)}&key=${apiKey}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      log.warn({ handle, status: res.status }, "YouTube API non-2xx");
      return null;
    }
    const data = await res.json() as { items?: Array<{ id: string; snippet: { title: string } }> };
    const item = data.items?.[0];
    if (!item) return null;
    return { channelId: item.id, handle: `@${cleanHandle}`, name: item.snippet.title };
  } catch (err) {
    log.warn({ handle, err: err instanceof Error ? err.message : String(err) }, "YouTube resolve threw");
    return null;
  }
}

/** Resolve a known YouTube channelId to its display name (for display-name auto-fill). */
export async function resolveYouTubeById(
  channelId: string,
  apiKey: string,
): Promise<ResolvedYouTubeChannel | null> {
  const url =
    `https://www.googleapis.com/youtube/v3/channels` +
    `?part=snippet&id=${encodeURIComponent(channelId)}&key=${apiKey}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const data = await res.json() as { items?: Array<{ id: string; snippet: { title: string; customUrl?: string } }> };
    const item = data.items?.[0];
    if (!item) return null;
    return {
      channelId: item.id,
      ...(item.snippet.customUrl && { handle: item.snippet.customUrl.startsWith("@") ? item.snippet.customUrl : `@${item.snippet.customUrl}` }),
      name: item.snippet.title,
    };
  } catch {
    return null;
  }
}

/** Resolve a "legacy custom URL" (youtube.com/c/<name>) by searching and picking the best match. */
export async function resolveYouTubeBySearch(
  query: string,
  apiKey: string,
): Promise<ResolvedYouTubeChannel | null> {
  const url =
    `https://www.googleapis.com/youtube/v3/search` +
    `?part=snippet&q=${encodeURIComponent(query)}&type=channel&maxResults=1&key=${apiKey}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const data = await res.json() as { items?: Array<{ snippet: { channelId: string; title: string } }> };
    const item = data.items?.[0];
    if (!item) return null;
    return { channelId: item.snippet.channelId, name: item.snippet.title };
  } catch {
    return null;
  }
}

// ─── Twitter / X ──────────────────────────────────────────────────────

export interface ResolvedTwitterUser {
  handle: string;     // canonical username (X returns this)
  userId: string;
  name: string;
}

export async function resolveTwitterByHandle(
  handle: string,
  bearer: string,
): Promise<ResolvedTwitterUser | null> {
  const clean = handle.startsWith("@") ? handle.slice(1) : handle;
  const url = `https://api.x.com/2/users/by/username/${encodeURIComponent(clean)}?user.fields=name`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${bearer}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 429) {
      log.warn({ handle }, "X API rate-limited (429)");
      return null;
    }
    if (!res.ok) {
      log.warn({ handle, status: res.status }, "X API non-2xx");
      return null;
    }
    const data = await res.json() as { data?: { id: string; name: string; username: string } };
    if (!data.data) return null;
    return { handle: data.data.username, userId: data.data.id, name: data.data.name || clean };
  } catch (err) {
    log.warn({ handle, err: err instanceof Error ? err.message : String(err) }, "X resolve threw");
    return null;
  }
}

// ─── Substack ─────────────────────────────────────────────────────────

export interface ResolvedSubstackNewsletter {
  subdomain: string;
  name: string;
}

/** Validate a Substack subdomain by hitting its public RSS feed. Title element gives us the display name. */
export async function resolveSubstack(subdomain: string): Promise<ResolvedSubstackNewsletter | null> {
  const cleanSub = subdomain.replace(/^https?:\/\//, "").replace(/\.substack\.com.*$/, "").trim();
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(cleanSub)) return null;
  const url = `https://${cleanSub}.substack.com/feed`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const xml = await res.text();
    const m = xml.match(/<title>([\s\S]*?)<\/title>/);
    const name = (m?.[1] ?? cleanSub).replace(/<!\[CDATA\[(.*?)\]\]>/, "$1").trim() || cleanSub;
    return { subdomain: cleanSub.toLowerCase(), name };
  } catch (err) {
    log.warn({ subdomain, err: err instanceof Error ? err.message : String(err) }, "substack resolve threw");
    return null;
  }
}

// ─── Blog RSS ─────────────────────────────────────────────────────────

export interface ResolvedBlogFeed {
  url: string;       // canonical feed URL
  name: string;
  type: "rss" | "atom";
}

/** Validate an RSS / Atom feed URL by parsing for <title>. */
export async function resolveBlogFeed(feedUrl: string): Promise<ResolvedBlogFeed | null> {
  try {
    const res = await fetch(feedUrl, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const xml = await res.text();
    const isAtom = xml.includes("<feed") && !xml.includes("<rss");
    const titleMatch = xml.match(/<title[^>]*>([\s\S]*?)<\/title>/);
    if (!titleMatch) return null;
    const name = titleMatch[1]!.replace(/<!\[CDATA\[(.*?)\]\]>/, "$1").trim();
    return { url: feedUrl, name, type: isAtom ? "atom" : "rss" };
  } catch (err) {
    log.warn({ url: feedUrl, err: err instanceof Error ? err.message : String(err) }, "blog feed resolve threw");
    return null;
  }
}

/** Try to discover a feed URL from a website root. Looks for <link rel="alternate" type="application/rss+xml" href="..."/>. */
export async function discoverFeedUrl(siteUrl: string): Promise<string | null> {
  try {
    const res = await fetch(siteUrl, { signal: AbortSignal.timeout(10_000), redirect: "follow" });
    if (!res.ok) return null;
    const html = await res.text();
    // Try common <link> patterns
    const linkRe = /<link[^>]+rel=["']alternate["'][^>]+type=["']application\/(rss|atom)\+xml["'][^>]+href=["']([^"']+)["']/i;
    const m = html.match(linkRe);
    if (m) return absoluteUrl(siteUrl, m[2]!);
    // Reverse order
    const linkRe2 = /<link[^>]+href=["']([^"']+)["'][^>]+type=["']application\/(rss|atom)\+xml["'][^>]+rel=["']alternate["']/i;
    const m2 = html.match(linkRe2);
    if (m2) return absoluteUrl(siteUrl, m2[1]!);
    // Common conventions
    for (const path of ["/feed", "/rss", "/feed.xml", "/rss.xml", "/atom.xml"]) {
      const candidate = absoluteUrl(siteUrl, path);
      const headRes = await fetch(candidate, { signal: AbortSignal.timeout(5_000) }).catch(() => null);
      if (headRes && headRes.ok) {
        const ct = headRes.headers.get("content-type") ?? "";
        if (ct.includes("xml") || ct.includes("rss") || ct.includes("atom")) return candidate;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function absoluteUrl(base: string, path: string): string {
  try { return new URL(path, base).toString(); } catch { return path; }
}
