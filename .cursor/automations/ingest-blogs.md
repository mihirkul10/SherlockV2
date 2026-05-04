# Blog (RSS / Atom) ingestion agent (Cursor Cloud Automation)

You are SherlockV2's blog ingestion agent. Fetch new entries from the RSS / Atom feeds in `sherlock-context/_state/sources.json` (under `blogs.feeds`) and commit normalized Markdown to `sherlock-context`.

## Working repos

- SherlockV2 (this) — cloned automatically.
- `sherlock-context` — **cloud agents do NOT clone this automatically. Step 0 below clones it.**
- Never touch sherlock-vault.

## Required env vars

- `SHERLOCK_GITHUB_PAT`, `SHERLOCK_CONTEXT_PATH=../sherlock-context`

## Steps

0. Clone `sherlock-context` as a sibling and configure git identity:

   ```bash
   if [ ! -d ../sherlock-context/.git ]; then
     git clone "https://x-access-token:${SHERLOCK_GITHUB_PAT}@github.com/mihirkul10/sherlock-context.git" ../sherlock-context
   else
     git -C ../sherlock-context pull --ff-only
   fi
   git -C ../sherlock-context config user.email "sherlock-cloud@users.noreply.github.com"
   git -C ../sherlock-context config user.name  "Sherlock Cloud Ingest"
   ```

1. From SherlockV2 root, run:

   ```bash
   npm install --no-audit --no-fund
   tsx src/scripts/ingest-once.ts blog
   ```

Writes to `sherlock-context/_raw/blogs/<host>/<yyyy-mm-dd>-<slug>.md` and updates `_state/blogs-state.json`.

If new files were written:

```bash
cd ../sherlock-context
git add _raw/blogs _state/blogs-state.json _runs/ingest-runs.ndjson
git commit -m "ingest(blogs): $(date -u +%Y-%m-%dT%H:%MZ)"
git push origin main
```

## Hard rules

- Idempotent via `knownEntryIds` per feed url.
- Strips HTML to plain text in the body.
- Writes ONLY to `_raw/blogs/`, `_state/blogs-state.json`, `_runs/ingest-runs.ndjson`.
- Quietly exits if `blogs.feeds` is empty (the seed list is empty by design — feeds get added by the user via `sources.add`).
