# SherlockV2

Cursor-native personal research analyst. Cloud-scheduled ingestion + cloud-maintained shared retrieval index + a local two-tier agent that turns iMessage questions into Markdown reports in your Obsidian vault.

> Architecture: see [the plan](file:///Users/sherlockkulkarni/.cursor/plans/sherlockv2_cursor-native_plan_4760e458.plan.md).

## Three-repo layout

| Repo | Purpose | Who writes |
|------|---------|------------|
| [`SherlockV2`](https://github.com/mihirkul10/SherlockV2) (this) | Code: bridge, agents, MCP tools, ingest scripts, automations | You / agent |
| [`sherlock-context`](https://github.com/mihirkul10/sherlock-context) | Raw normalized Markdown from cloud ingestion | Cloud agents only (PAT-firewalled) |
| [`sherlock-vault`](https://github.com/mihirkul10/sherlock-vault) | Obsidian — research reports + your notes | Local researchers + you |

## Four kinds of agents

1. **Cloud ingestion agents** (`.cursor/automations/ingest-*.md`) — Cursor Cloud Automations on a schedule. Each writes one source-type to `sherlock-context`.
2. **Cloud indexing agent** (`.cursor/automations/index-context.md`) — Cursor Cloud Automation that diffs `sherlock-context/_raw`, chunks documents, computes embeddings when configured, and upserts the shared retrieval index.
3. **Sherlock-Front** (`src/bridge/front-runner.ts`) — local SDK agent spawned per iMessage turn. Always responsive. Recon → scope → confirm → delegate. Model: `claude-haiku-4-5`.
4. **Sherlock-Researcher** (`src/bridge/researcher-runner.ts`) — on-demand local SDK sub-agents (cap = 3 concurrent). Each writes a Markdown report to `sherlock-vault/Reports/` and DMs you when done. Model: `claude-sonnet-4-6`.

> Models are routed through Cursor (`@cursor/sdk` + `CURSOR_API_KEY`); see `npm run list:models` to inspect the catalog.

## Quick start

### 1. Credentials (`~/.sherlock/.env`)

| Var | Used by |
|-----|---------|
| `CURSOR_API_KEY` | every `Agent.create` / `Agent.prompt` |
| `SHERLOCK_GITHUB_PAT` | git push from cloud agents + local report writes |
| `PARALLEL_API_KEY` | Parallel Search + Task MCPs |
| `SHERLOCK_CONTEXT_API_URL` | shared retrieval API base URL for `context.*` tools + cloud index sync |
| `SHERLOCK_CONTEXT_API_TOKEN` | bearer token for the shared retrieval API |
| `YOUTUBE_API_KEY` | YouTube Data API (handle resolution) |
| `APIFY_API_TOKEN` | YouTube transcript extraction (`starvibe/youtube-video-transcript`) |
| `TWITTER_BEARER_TOKEN` | X API v2 read |
| `BLUEBUBBLES_PASSWORD`, `BLUEBUBBLES_URL` | iMessage bridge |
| `ADMIN_IMESSAGE` | fallback chat for proactive notifications |
| `VOYAGE_API_KEY` | optional semantic embeddings for the shared index |

See `.env.example` for the full list with descriptions.

### 2. One-time install

```bash
npm install
npm run smoke:sdk            # validates CURSOR_API_KEY (local + cloud SDK round-trip)
npm run resolve:youtube      # 29 @handles -> UC channelIds
npm run resolve:twitter      # 4 @handles + @mihirkul10 -> userIds
npm run seed:sources         # writes sherlock-context/_state/sources.json
npm run reindex              # cold rebuild of local SQLite FTS5 index
./launchd/install.sh         # installs all 4 launchd jobs
```

### 3. Obsidian one-time setup

1. `open -a Obsidian` and pick "Open folder as vault" → `~/Projects/sherlock-vault`.
2. Settings → Community plugins → install **Obsidian Git** by Vinzent. Configure:
   - Pull on startup, auto-pull every 5 min, auto-push on commit OFF.
3. `cd ~/Projects/sherlock-vault && git pull` once in Terminal so macOS Keychain stores the PAT.

### 4. Cloud automations (Cursor dashboard)

Cursor's scheduled automations live in the [Cloud Agents dashboard](https://cursor.com/dashboard/cloud-agents) — point each at the matching automation file in this repo. Suggested cron schedules:

- `ingest-youtube`: `*/30 * * * *`
- `ingest-twitter-people`: `*/15 * * * *`
- `ingest-substack`: `0 * * * *`
- `ingest-blogs`: `0 */2 * * *`
- `index-context`: `*/15 * * * *`
- `ingest-twitter-bookmarks`: deferred (needs X OAuth user-context)

Cloud automation env vars (set in **My Secrets** of the Cloud Agents dashboard): `CURSOR_API_KEY`, `SHERLOCK_GITHUB_PAT`, `SHERLOCK_CONTEXT_API_URL`, `SHERLOCK_CONTEXT_API_TOKEN`, `YOUTUBE_API_KEY`, `APIFY_API_TOKEN`, `TWITTER_BEARER_TOKEN`, `PARALLEL_API_KEY`, `VOYAGE_API_KEY`.

## Local services

Five primary launchd jobs run continuously on the Sherlock Mac:

| Service | What | Logs |
|---------|------|------|
| `com.sherlock.context-api` | shared retrieval API used by Front + Researcher after reboot | `~/Library/Logs/sherlock-context-api.log` |
| `com.sherlock.bridge` | iMessage bridge + Front + research job manager | `~/Library/Logs/sherlock-bridge.log` |
| `com.sherlock.context-sync` | `git pull --ff-only` on `sherlock-context` every 60 s | `~/Library/Logs/sherlock-context-sync.log` |
| `com.sherlock.context-index-sync` | runs `npm run index:cloud` every 90 s to refresh the shared local index from pulled raw corpus | `~/Library/Logs/sherlock-context-index-sync.log` |
| `com.sherlock.vault-sync` | `git pull --ff-only` on `sherlock-vault` every 60 s | `~/Library/Logs/sherlock-vault-sync.log` |

Manage with `./launchd/install.sh` and `./launchd/uninstall.sh`.

For the shared index itself, run `npm run context:api` on whichever host should own the retrieval service. On the Sherlock Mac, `SHERLOCK_CONTEXT_API_URL=http://127.0.0.1:18840` is sufficient for reboot-safe local operation. If you later deploy a network-reachable host, point both the Mac and the cloud automation at that URL instead.

`com.sherlock.indexer` remains available as a fallback/offline legacy service, but it is no longer part of the primary boot path.

For a permanent always-on shared index, deploy `npm run context:api` to Render
or another host with persistent disk. A ready-to-import Render blueprint lives
at `render.yaml`; see `docs/render-context-api.md` for the cutover steps.

## Daily ops

| Need to... | Do this |
|------------|---------|
| Add a new source | Paste any URL into iMessage: `add this source: <url>`. Front calls `sources.add` MCP, the resolver figures out the type, validates, commits to `sherlock-context`. |
| Ask a quick question | Just message Sherlock. Front does fast recon (local + web) and replies in seconds with citations. |
| Get a deep report | Message Sherlock with an open-ended question. Front asks one scoping question, then offers to spin up a Researcher. On confirmation: `research.start` → 5-15 min → DM with `obsidian://` link to the report. |
| See what's running | "what are you working on?" → Front calls `research.list_active`. |
| Cancel a report | "cancel #N" → Front calls `research.cancel`. |
| Force-run an ingestor | `npm run ingest -- youtube` (or `twitter-people`, `substack`, `blog`). Optionally `--handle @x`. |
| Rebuild the fallback local index | `npm run reindex`. |
| Sync the shared cloud index immediately | `npm run index:cloud`. |
| Health check | `curl http://127.0.0.1:18790/healthz` |
| See bridge state | `curl http://127.0.0.1:18790/state` |
| Open the Admin snapshot | Open `~/.cursor/projects/Users-sherlockkulkarni-Projects-SherlockV2/canvases/admin.canvas.tsx` in Cursor. Static — re-render to refresh. |

## Verification

Each milestone has an executable battery you can re-run anytime:

```bash
./scripts/verify-m0.sh   # foundation: repos, credentials, launchd, git round-trip
./scripts/verify-m1.sh   # YouTube ingest path, Apify spend, idempotency
./scripts/verify-m2.sh   # local FTS5 index + Sherlock-Front Q&A path
./scripts/verify-m3.sh   # research sub-agents, concurrency cap, cancel, reports
./scripts/verify-m4.sh   # paste-URL onboarding, all 4 ingestors, cross-source
./scripts/verify-m5.sh   # shared retrieval API + cloud index sync + backend handoff path
```

## Troubleshooting

- **Bridge won't start** — `lsof -iTCP:18790` to find a stale process; kill it.
- **iMessage messages aren't routing** — confirm BlueBubbles is running (`curl $BLUEBUBBLES_URL/api/v1/server/info?password=$BLUEBUBBLES_PASSWORD`); confirm webhook registration in `~/Library/Logs/sherlock-bridge.log`.
- **Researcher hangs** — `curl -X POST http://127.0.0.1:18790/research/<id>/cancel` (also covered by 30-min hard timeout in the job manager).
- **Shared index is stale** — check the `index-context` cloud automation, then query the retrieval service via `curl $SHERLOCK_CONTEXT_API_URL/query/stats -H "Authorization: Bearer $SHERLOCK_CONTEXT_API_TOKEN"`.
- **Apify failures spike** — `curl https://api.apify.com/v2/users/me/usage/monthly?token=$APIFY_API_TOKEN` to see month-to-date usage; switch transcript path or top up.
- **Vault git conflicts** — vault writes are confined to `Reports/` so conflicts with your hand-edited `Notes/` shouldn't happen. If they do, manual resolve in `~/Projects/sherlock-vault`, then `git push`.

## Status

| Milestone | Status |
|-----------|--------|
| M0 — foundation | ✅ verified (10/10) |
| M1 — YouTube ingest | ✅ verified (16/16) — 30 transcripts, 100% success, $0.16 spend |
| M2 — local index + Sherlock-Front | ✅ verified (9/9) — citation-grade Q&A in ~16 s |
| M3 — Researcher + concurrency | ✅ verified (15/15) — first real report, 605 s, 15 citations |
| M4 — remaining ingestors + URL onboarding + Canvas | ✅ — Twitter+blog ingestors, paste-URL flow, Admin snapshot, launchd plists |
