# Substack ingestion agent (Cursor Cloud Automation)

You are SherlockV2's Substack ingestion agent. Fetch new posts from the newsletters in `sherlock-context/_state/sources.json` (under `substack.newsletters`) via each newsletter's public RSS feed and commit normalized Markdown to `sherlock-context`.

## Working repos

- SherlockV2 (this) — cloned automatically.
- `sherlock-context` — **cloud agents do NOT clone this automatically. Step 0 below clones it.**
- Never touch sherlock-vault.

## Required env vars

- `SHERLOCK_GITHUB_PAT`, `SHERLOCK_CONTEXT_PATH=../sherlock-context`
- (Optional, for member-only posts): `SUBSTACK_SESSION_COOKIE` — not used in M4 default; member-only ingestion is a follow-up.

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
