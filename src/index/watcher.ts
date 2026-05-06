/**
 * Chokidar-based incremental fallback indexer. Watches sherlock-context/_raw
 * for Markdown additions/modifications/deletions and keeps the legacy local
 * SQLite FTS5 index in sync without a full rebuild.
 *
 * Lifecycle:
 *   1. On startup, do a one-time bulk reindex (cheap; ~thousands of files
 *      in <2s on M1/M2 Mac SQLite).
 *   2. Then go into incremental mode — watch _raw for changes.
 *
 * Started either as a launchd service (com.sherlock.indexer) or in-process
 * by the bridge.
 */

import chokidar, { type FSWatcher } from "chokidar";
import { CONTEXT_RAW_DIR } from "../shared/paths.js";
import { indexFile, reindexAll } from "./loader.js";
import { deleteByPath, getStats } from "./sqlite-fts.js";
import { createLogger } from "../shared/logger.js";

const log = createLogger("index:watcher");

let watcher: FSWatcher | null = null;

export interface WatcherOptions {
  /** Skip the initial cold-rebuild on startup (defaults to false). */
  skipInitialReindex?: boolean;
}

export async function startWatcher(opts: WatcherOptions = {}): Promise<void> {
  if (!opts.skipInitialReindex) {
    log.info("performing initial cold reindex…");
    const r = await reindexAll();
    log.info({ ...r, ...getStats() }, "✓ initial reindex done");
  } else {
    log.info("skipped initial reindex (using existing index db)");
  }

  log.info({ root: CONTEXT_RAW_DIR }, "starting chokidar watcher");
  watcher = chokidar.watch(`${CONTEXT_RAW_DIR}/**/*.md`, {
    ignoreInitial: true, // we already did the cold scan above
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
  });

  watcher
    .on("add", (path: string) => {
      const doc = indexFile(path);
      log.info({ path, indexed: !!doc }, "add");
    })
    .on("change", (path: string) => {
      const doc = indexFile(path);
      log.info({ path, indexed: !!doc }, "change");
    })
    .on("unlink", (path: string) => {
      const removed = deleteByPath(path);
      log.info({ path, removed }, "unlink");
    })
    .on("error", (err: unknown) => log.error({ err: err instanceof Error ? err.message : String(err) }, "watcher error"));
}

export async function stopWatcher(): Promise<void> {
  if (watcher) {
    await watcher.close();
    watcher = null;
    log.info("watcher stopped");
  }
}
