/**
 * Resolves Twitter @handles to canonical numeric userIds via the X API v2
 * `/2/users/by/username/<handle>` endpoint.
 *
 * Input  : the 4 followed people + the user's own handle (for bookmarks).
 * Output : prints JSON `{ people: [...], me: {...} }` to stdout.
 *
 * Usage:
 *   npm run resolve:twitter > /tmp/twitter-people.json
 *   tsx src/scripts/resolve-twitter-handles.ts --pretty
 */

import { loadEnv, requireEnv } from "../shared/env.js";
import { createLogger } from "../shared/logger.js";

const log = createLogger("resolve:twitter");

// Real roster from plan §6.5 — order preserved.
export const SEED_PEOPLE = [
  { handle: "dwarkesh_sp",    fallbackName: "Dwarkesh Patel" },
  { handle: "gametheorizing", fallbackName: "Game Theorizing" },
  { handle: "lennysan",       fallbackName: "Lenny" },
  { handle: "cburniske",      fallbackName: "Chris Burniske" },
] as const;

export const ME_HANDLE = "mihirkul10";

interface ResolvedUser {
  handle: string;
  userId: string;
  name: string;
}

async function resolveOne(handle: string, bearer: string, fallbackName?: string): Promise<ResolvedUser | null> {
  const url = `https://api.x.com/2/users/by/username/${encodeURIComponent(handle)}?user.fields=name`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${bearer}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 429) {
      log.warn({ handle }, "Rate limited (429). X free tier is strict — sleeping 60s and retrying once.");
      await new Promise((r) => setTimeout(r, 60_000));
      return resolveOne(handle, bearer);
    }
    if (!res.ok) {
      log.error({ handle, status: res.status, body: await res.text() }, "API error");
      return null;
    }
    const data = await res.json() as { data?: { id: string; name: string; username: string } };
    if (!data.data) {
      log.warn({ handle }, "No user found");
      return null;
    }
    return { handle: data.data.username, userId: data.data.id, name: data.data.name || fallbackName || handle };
  } catch (err) {
    log.error({ handle, err: err instanceof Error ? err.message : String(err) }, "Resolve failed");
    return null;
  }
}

async function main(): Promise<void> {
  loadEnv();
  const bearer = requireEnv("TWITTER_BEARER_TOKEN", "X API v2 bearer (already in ~/.sherlock/.env)");
  const pretty = process.argv.includes("--pretty");

  const allHandles = [...SEED_PEOPLE.map((p) => p.handle), ME_HANDLE];
  log.info("Resolving %d Twitter handles…", allHandles.length);

  const people: ResolvedUser[] = [];
  let me: ResolvedUser | null = null;
  const failures: string[] = [];

  for (const seed of SEED_PEOPLE) {
    const resolved = await resolveOne(seed.handle, bearer, seed.fallbackName);
    if (resolved) {
      people.push(resolved);
      log.info({ handle: resolved.handle, userId: resolved.userId, name: resolved.name }, "✓");
    } else {
      failures.push(seed.handle);
    }
    // Pace ourselves on the X free tier.
    await new Promise((r) => setTimeout(r, 1_500));
  }

  me = await resolveOne(ME_HANDLE, bearer, "Mihir Kulkarni");
  if (me) {
    log.info({ handle: me.handle, userId: me.userId }, "✓ me (for bookmarks)");
  } else {
    failures.push(ME_HANDLE);
  }

  if (failures.length > 0) {
    log.error({ failures }, "Some handles failed to resolve");
    process.stdout.write(JSON.stringify({ ok: false, failures, people, me }, null, pretty ? 2 : 0));
    process.exit(1);
  }

  process.stdout.write(JSON.stringify({ ok: true, people, me }, null, pretty ? 2 : 0));
  process.stdout.write("\n");
}

main().catch((err) => {
  log.fatal({ err: err instanceof Error ? err.message : String(err) }, "crashed");
  process.exit(2);
});
