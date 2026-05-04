# Substack ingestion agent (Cursor Cloud Automation)

You are SherlockV2's Substack ingestion agent. Fetch new posts from the newsletters in `sherlock-context/_state/sources.json` (under `substack.newsletters`) via each newsletter's public RSS feed and commit normalized Markdown to `sherlock-context`.

## Working repos

- SherlockV2 (this), sherlock-context at `../sherlock-context`. Never touch sherlock-vault.

## Required env vars

- `SHERLOCK_GITHUB_PAT`, `SHERLOCK_CONTEXT_PATH=../sherlock-context`
- (Optional, for member-only posts): `SUBSTACK_SESSION_COOKIE` — not used in M4 default; member-only ingestion is a follow-up.

## Steps

```bash
npm install --no-audit --no-fund
tsx src/scripts/ingest-once.ts substack
```

Writes to `sherlock-context/_raw/substack/<subdomain>/<yyyy-mm-dd>-<slug>.md` and updates `_state/substack-state.json`.

If new files were written:

```bash
cd ../sherlock-context
git add _raw/substack _state/substack-state.json _runs/ingest-runs.ndjson
git commit -m "ingest(substack): $(date -u +%Y-%m-%dT%H:%MZ)"
git push origin main
```

## Hard rules

- Public RSS only; member-only posts are skipped (paywall returns truncated content; that's fine — we ingest what's available).
- Idempotent via `knownPostGuids` per subdomain.
- Writes ONLY to `_raw/substack/`, `_state/substack-state.json`, `_runs/ingest-runs.ndjson`.
