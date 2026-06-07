/**
 * Read-only staleness alarm for the shared retrieval index.
 *
 * Compares the hosted index against the local sherlock-context corpus and
 * fires a macOS notification when something needs attention:
 *   - the retrieval API is unreachable
 *   - the index has lost documents (e.g. a platform-side disk wipe)
 *   - no new content has been ingested for several days (ingest pipeline dead)
 *
 * Never writes to the index — safe to run alongside the single cloud indexer.
 */

import { execFileSync } from "node:child_process";
import { glob } from "node:fs/promises";
import { CONTEXT_RAW_DIR } from "../shared/paths.js";
import { createLogger } from "../shared/logger.js";
import { loadEnv } from "../shared/env.js";
import { remoteStats } from "../retrieval/api-client.js";

loadEnv();
const log = createLogger("index-freshness");

const STALE_PUBLISHED_DAYS = 3;

function notify(message: string): void {
  log.warn({ message }, "index freshness alert");
  try {
    execFileSync("osascript", [
      "-e",
      `display notification ${JSON.stringify(message)} with title "Sherlock index alarm" sound name "Basso"`,
    ]);
  } catch {
    // notification is best-effort; the log line above is the durable record
  }
}

async function localRawCount(): Promise<number> {
  let count = 0;
  for await (const _file of glob(`${CONTEXT_RAW_DIR}/**/*.md`)) count++;
  return count;
}

async function main(): Promise<number> {
  const local = await localRawCount();

  let stats: Awaited<ReturnType<typeof remoteStats>>;
  try {
    stats = await remoteStats({});
  } catch (err) {
    notify(`Retrieval API unreachable: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  const alerts: string[] = [];
  if (stats.total < Math.floor(local * 0.9)) {
    alerts.push(
      `Index has ${stats.total} docs but the local corpus has ${local} — the index lost data or the cloud indexer is dead. ` +
      `Rebuild: npm run index:cloud`,
    );
  }
  if (stats.newest_published_at) {
    const ageDays = (Date.now() - Date.parse(stats.newest_published_at)) / 86_400_000;
    if (ageDays > STALE_PUBLISHED_DAYS) {
      alerts.push(
        `Newest corpus content is ${Math.floor(ageDays)} days old — ingest may be dead (check Cursor automations / usage limits).`,
      );
    }
  }

  if (alerts.length === 0) {
    log.info({ local, remote: stats.total, newest_published_at: stats.newest_published_at }, "index is fresh");
    return 0;
  }
  for (const alert of alerts) notify(alert);
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    log.error({ err: err instanceof Error ? err.message : String(err) }, "freshness check crashed");
    process.exit(1);
  });
