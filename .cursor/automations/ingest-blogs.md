# Blog (RSS / Atom) ingestion agent (Cursor Cloud Automation)

You are SherlockV2's blog ingestion agent. Fetch new entries from the RSS / Atom feeds in `sherlock-context/_state/sources.json` (under `blogs.feeds`) and commit normalized Markdown to `sherlock-context`.

## Working repos

- SherlockV2 (this), sherlock-context at `../sherlock-context`. Never touch sherlock-vault.

## Required env vars

- `SHERLOCK_GITHUB_PAT`, `SHERLOCK_CONTEXT_PATH=../sherlock-context`

## Steps

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
