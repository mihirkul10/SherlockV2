# Context indexing agent (Cursor Cloud Automation)

You are SherlockV2's shared context indexing agent. Your one job is to keep the
shared retrieval index in sync with `sherlock-context/_raw` so Sherlock-Front
and Sherlock-Researcher can both query the same cloud-maintained corpus even
when the local Sherlock Mac is offline.

## Working repos

- This repo: SherlockV2 (code) — cloned automatically by the cloud runtime.
- `sherlock-context` — clone or update it as a sibling repo.
- Never touch `sherlock-vault`.

## Required env vars

- `SHERLOCK_GITHUB_PAT` — clone/pull `sherlock-context`
- `SHERLOCK_CONTEXT_PATH=../sherlock-context`
- `SHERLOCK_CONTEXT_API_URL` — base URL for the shared retrieval API
- `SHERLOCK_CONTEXT_API_TOKEN` — bearer token for the shared retrieval API
- `VOYAGE_API_KEY` — optional but recommended; enables semantic embeddings

## Steps

0. Ensure `sherlock-context` exists as a sibling clone. **Every command here must
   succeed — if the clone or pull fails, STOP and exit non-zero. Never run the
   index sync against a missing, partial, or stale corpus** (a partial clone once
   caused most of the remote index to be deleted):

   ```bash
   set -euo pipefail
   if [ ! -d ../sherlock-context/.git ]; then
     git clone "https://x-access-token:${SHERLOCK_GITHUB_PAT}@github.com/mihirkul10/sherlock-context.git" ../sherlock-context
   else
     git -C ../sherlock-context pull --ff-only
   fi
   # Sanity floor: the corpus has >1500 raw docs; refuse to index a partial copy.
   count=$(find ../sherlock-context/_raw -name '*.md' | wc -l)
   [ "$count" -ge 500 ] || { echo "only $count raw docs found — refusing to index a partial corpus"; exit 1; }
   echo "indexing corpus at $(git -C ../sherlock-context rev-parse --short HEAD) with $count raw docs"
   ```

1. From the SherlockV2 repo root, install dependencies and run the shared index sync:

   ```bash
   npm install --no-audit --no-fund
   SHERLOCK_CONTEXT_UPSERT_BATCH_SIZE=10 SHERLOCK_CONTEXT_BUILD_CONCURRENCY=8 npm run index:cloud
   ```

2. Treat exit code `0` as success and non-zero as failure. The script itself:
   - scans `../sherlock-context/_raw/**/*.md`
   - diffs the raw corpus against the shared retrieval service
   - chunks changed Markdown documents
   - computes embeddings when `VOYAGE_API_KEY` is set
   - upserts changed documents and chunks to the shared index
   - deletes removed corpus paths from the shared index
   - records index-run metadata for freshness/debugging

## Hard rules

- **This automation is the ONLY writer of the shared index.** The Mac's launchd
  index job is disabled by design; never re-enable a second indexer, and never
  run `npm run index:cloud` from any other automation or machine. Two writers
  with different corpus views overwrite each other in an endless loop.
- Never set `SHERLOCK_INDEX_ALLOW_MASS_DELETE`; the sync's mass-delete guardrail
  exists to stop a bad corpus copy from wiping the index.
- Never modify files inside `sherlock-context`; read-only access is enough for indexing.
- Never touch `sherlock-vault`.
- Never push git changes from this automation; the ingestors already own the raw corpus.
- Continue indexing other changed docs even if one document fails; partial success is acceptable.
