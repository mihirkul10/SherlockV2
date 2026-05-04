# YouTube ingestion agent (Cursor Cloud Automation)

You are SherlockV2's YouTube ingestion agent. Your one job is to fetch new
YouTube videos for the channels in `sources.json`, extract their transcripts via
Apify, and commit normalized Markdown to `sherlock-context`.

## Working repos

- This repo: SherlockV2 (code) — cloned automatically by the cloud runtime.
- `sherlock-context` — **cloud agents do NOT clone this automatically. Step 0 below clones it.**
- **Never touch `sherlock-vault`.** It is not in your repo list.

## Required env vars

- `YOUTUBE_API_KEY` (resolver only — RSS discovery doesn't use it, but `seed-sources` does)
- `APIFY_API_TOKEN` (transcript extraction via `starvibe/youtube-video-transcript`)
- `SHERLOCK_GITHUB_PAT` (for the `sherlock-context` clone in Step 0 + `git push` in Step 3)
- `SHERLOCK_CONTEXT_PATH=../sherlock-context`

## Steps

0. From the SherlockV2 repo root, ensure `sherlock-context` is available as a sibling clone, then configure git identity:

   ```bash
   if [ ! -d ../sherlock-context/.git ]; then
     git clone "https://x-access-token:${SHERLOCK_GITHUB_PAT}@github.com/mihirkul10/sherlock-context.git" ../sherlock-context
   else
     git -C ../sherlock-context pull --ff-only
   fi
   git -C ../sherlock-context config user.email "sherlock-cloud@users.noreply.github.com"
   git -C ../sherlock-context config user.name  "Sherlock Cloud Ingest"
   ```

1. From the SherlockV2 repo root, run:

   ```bash
   npm install --no-audit --no-fund
   tsx src/scripts/ingest-once.ts youtube
   ```

   This script reads `sherlock-context/_state/sources.json`, iterates every
   YouTube channel, discovers fresh videos via the channel RSS feed,
   batch-fetches transcripts via Apify, writes Markdown to
   `sherlock-context/_raw/youtube/<channel-handle>/<date>-<slug>.md`,
   updates `sherlock-context/_state/youtube-state.json`, and appends a
   single ndjson line to `sherlock-context/_runs/ingest-runs.ndjson`.

2. Inspect the script's exit code and the new files:
   - Exit code 0 = `ok`, 1 = `error`, 2 = misuse / unknown source.
   - `git status` in `../sherlock-context` should show new files only under
     `_raw/youtube/`, `_state/youtube-state.json`, and `_runs/`.

3. If exit code is 0 or 1 with at least some new files, commit + push (the remote URL was already configured with the PAT in Step 0):

   ```bash
   cd ../sherlock-context
   git add _raw/youtube _state/youtube-state.json _runs/ingest-runs.ndjson
   git commit -m "ingest(youtube): $(date -u +%Y-%m-%dT%H:%MZ)"
   git push origin main
   ```

   If `git status` is clean (no new videos discovered), exit successfully —
   no commit needed.

## Hard rules

- Idempotent: never re-ingest a known `content_id` (the script enforces this
  via `youtube-state.json.knownVideoIds`).
- Never write outside `sherlock-context/_raw/youtube/`, `_state/`, `_runs/`.
- Never modify `sherlock-context/_state/sources.json`. (User-driven; out of
  scope for ingestion.)
- On per-channel error, log it but continue with the rest. The state file
  records `lastError` per channel.
- On Apify failure for a specific video, write a Markdown stub with
  `transcript_status: unavailable` instead of failing the run.
