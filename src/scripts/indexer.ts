/**
 * Long-running fallback indexer process — performs an initial cold-rebuild of
 * the local SQLite FTS5 index from sherlock-context/_raw, then watches for
 * changes via chokidar and incrementally upserts.
 *
 * Used for:
 *   - offline / emergency fallback when the shared retrieval API is unavailable
 *   - local smoke tests that still exercise the legacy Mac-local index
 *
 * Started by:  npm run indexer       (foreground / dev)
 *              launchctl load com.sherlock.indexer.plist  (fallback production)
 *
 * Logs to stdout (pino-pretty in dev). On signal, closes the watcher and exits.
 */

import { startWatcher, stopWatcher } from "../index/watcher.js";
import { closeIndexDb } from "../index/sqlite-fts.js";
import { loadEnv } from "../shared/env.js";
import { createLogger } from "../shared/logger.js";

loadEnv();
const log = createLogger("indexer");

async function main(): Promise<void> {
  log.info("starting SherlockV2 indexer");
  await startWatcher({ skipInitialReindex: false });
  log.info("indexer running — watching for context changes (Ctrl-C to stop)");
}

const shutdown = async (signal: string): Promise<void> => {
  log.info({ signal }, "indexer shutting down");
  await stopWatcher();
  closeIndexDb();
  process.exit(0);
};
process.on("SIGINT", () => { void shutdown("SIGINT"); });
process.on("SIGTERM", () => { void shutdown("SIGTERM"); });

main().catch((err) => {
  log.fatal({ err: err instanceof Error ? err.message : String(err) }, "indexer crashed");
  process.exit(1);
});
