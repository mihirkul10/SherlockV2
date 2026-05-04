/**
 * Cold rebuild of the local SQLite FTS5 index from sherlock-context/_raw.
 * Use after a git pull that brought in lots of new files, or after schema changes.
 *
 * Usage:  npm run reindex
 */

import { reindexAll } from "../index/loader.js";
import { closeIndexDb, getStats } from "../index/sqlite-fts.js";
import { loadEnv } from "../shared/env.js";
import { createLogger } from "../shared/logger.js";

const log = createLogger("script:reindex");

async function main(): Promise<number> {
  loadEnv();
  const t0 = Date.now();
  log.info("starting reindex…");
  const result = await reindexAll();
  const stats = getStats();
  log.info(
    { ms: Date.now() - t0, ...result, total: stats.total, bySource: stats.bySource },
    "✓ reindex complete"
  );
  closeIndexDb();
  return 0;
}

main().then((code) => process.exit(code)).catch((err) => {
  log.fatal({ err: err instanceof Error ? err.message : String(err) }, "reindex crashed");
  process.exit(1);
});
