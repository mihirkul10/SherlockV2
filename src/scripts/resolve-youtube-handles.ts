/**
 * Resolves a list of YouTube @handles to canonical UC channelIds via the
 * YouTube Data API v3 `channels.list?forHandle=...` endpoint.
 *
 * Input  : the 29 @handles from the SherlockV2 plan §6.5 (hardcoded below).
 * Output : prints JSON `[{ handle, channelId, name }]` to stdout, suitable for
 *          piping into `seed-sources.ts`.
 *
 * Fails loudly on any unresolved handle so we never seed sources.json with
 * placeholder ids.
 *
 * Usage:
 *   npm run resolve:youtube > /tmp/yt-channels.json
 *   tsx src/scripts/resolve-youtube-handles.ts --pretty
 */

import { loadEnv, requireEnv } from "../shared/env.js";
import { createLogger } from "../shared/logger.js";

const log = createLogger("resolve:youtube");

// Real roster from plan §6.5. DO NOT REORDER — order is preserved in sources.json.
export const SEED_HANDLES = [
  "@galaxydigitalhq",
  "@pantera-capital",
  "@stripe",
  "@0xSteadyLads",
  "@NatalieBrunell",
  "@UncommonCore",
  "@ScottMelker",
  "@messari", // Was @MessariCrypto in the original seed list — they renamed to plain @messari (channel UCFEHdhuB_BEUHA_eL9cjqHA, title "Messari")
  "@EpicenterTV",
  "@SolanaFndn",
  "@BlockchainatBerkeley",
  "@flywheeldefi",
  "@ForwardGuidanceBW",
  "@TheEconomicClubofNewYork",
  "@DeFiDad",
  "@theblockcrunchpodcast",
  "@zeroknowledgefm",
  "@Delphi_Digital",
  "@a16zcrypto",
  "@RaoulPalTJM",
  "@RealVisionFinance",
  "@TalkingTokens",
  "@TBPNLive",
  "@allin",
  "@a16z",
  "@RealEismanPlaybook",
  "@TOKEN2049",
  "@peterdiamandis",
  "@WhatBitcoinDidPod",
] as const;

interface ResolvedChannel {
  handle: string;
  channelId: string;
  name: string;
}

async function resolveOne(handle: string, apiKey: string): Promise<ResolvedChannel | null> {
  // forHandle expects the handle WITHOUT the leading @
  const cleanHandle = handle.startsWith("@") ? handle.slice(1) : handle;
  const url =
    `https://www.googleapis.com/youtube/v3/channels` +
    `?part=snippet&forHandle=${encodeURIComponent(cleanHandle)}&key=${apiKey}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      log.error({ handle, status: res.status, body: await res.text() }, "API error");
      return null;
    }
    const data = await res.json() as { items?: Array<{ id: string; snippet: { title: string } }> };
    const item = data.items?.[0];
    if (!item) {
      log.warn({ handle }, "No channel found for handle");
      return null;
    }
    return { handle, channelId: item.id, name: item.snippet.title };
  } catch (err) {
    log.error({ handle, err: err instanceof Error ? err.message : String(err) }, "Resolve failed");
    return null;
  }
}

async function main(): Promise<void> {
  loadEnv();
  const apiKey = requireEnv("YOUTUBE_API_KEY", "enable YouTube Data API v3 at console.cloud.google.com");

  const pretty = process.argv.includes("--pretty");
  log.info("Resolving %d YouTube @handles…", SEED_HANDLES.length);

  const results: ResolvedChannel[] = [];
  const failures: string[] = [];

  for (const handle of SEED_HANDLES) {
    const resolved = await resolveOne(handle, apiKey);
    if (resolved) {
      results.push(resolved);
      log.info({ handle, channelId: resolved.channelId, name: resolved.name }, "✓");
    } else {
      failures.push(handle);
    }
    // Polite pacing: YouTube quota is 10k units/day, channels.list = 1 unit each
    await new Promise((r) => setTimeout(r, 100));
  }

  log.info("Resolved %d / %d handles. Failures: %d", results.length, SEED_HANDLES.length, failures.length);
  if (failures.length > 0) {
    log.error({ failures }, "Some handles failed to resolve — fix and rerun before seeding");
    process.stdout.write(JSON.stringify({ ok: false, failures, results }, null, pretty ? 2 : 0));
    process.exit(1);
  }

  process.stdout.write(JSON.stringify({ ok: true, results }, null, pretty ? 2 : 0));
  process.stdout.write("\n");
}

main().catch((err) => {
  log.fatal({ err: err instanceof Error ? err.message : String(err) }, "crashed");
  process.exit(2);
});
