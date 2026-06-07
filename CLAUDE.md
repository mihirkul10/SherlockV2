# SherlockV2

Personal research analyst. Cloud-scheduled ingestion builds a Markdown corpus;
a hosted retrieval API serves semantic + lexical search over it; a local
bridge (iMessage) and researcher agents consume it; an admin dashboard
monitors everything.

## Repo topology (three sibling repos)

```
SherlockV2/          this repo — all code
../sherlock-context/ corpus: _raw/**/*.md (~1,500+ docs: youtube, twitter, blogs), _state/sources.json
../sherlock-vault/   Obsidian vault — research reports land here. Never write to it from automation.
```

`sherlock-context` is written by cloud ingest automations (committed as
"Sherlock Cloud Ingest") and pulled locally by a launchd job. Treat it as
read-only from code in this repo unless you are an ingest script.

## Secrets

All secrets live in `~/.sherlock/.env` (loaded by `loadEnv()` from
`src/shared/env.ts`). **Not in git — copy it to a new machine manually and
securely.** Key vars: `SHERLOCK_CONTEXT_API_URL`, `SHERLOCK_CONTEXT_API_TOKEN`,
`VOYAGE_API_KEY`, `TWITTER_BEARER_TOKEN`, `SHERLOCK_GITHUB_PAT`,
`ANTHROPIC_API_KEY`.

## Corpus access (works from any machine)

The hosted retrieval API (`SHERLOCK_CONTEXT_API_URL`, currently
https://sherlockv2.onrender.com — Render service `srv-d7tdc7egvqtc73cjouf0`,
persistent disk at /var/data) is the single source of corpus truth. Auth:
`Authorization: Bearer $SHERLOCK_CONTEXT_API_TOKEN`.

- `GET  /query/stats` — doc counts, by-source, freshness timestamps
- `POST /query/search` — `{"query": "...", "limit": 8, "filters": {"sources": ["youtube"]}}` —
  hybrid lexical (FTS5) + semantic (Voyage embeddings, computed server-side —
  clients need no Voyage key)
- `POST /query/brief`, `POST /query/followups` — planner-shaped retrieval
- `GET  /admin/corpus?limit=...&source=...` — browse documents
- TypeScript clients: `remoteSearch`/`remoteStats` in `src/retrieval/api-client.ts`

For raw-text grepping, the full corpus is also on disk at
`../sherlock-context/_raw/` if that repo is cloned.

## ⚠️ Single-writer rule (do not break)

**Exactly one process may write to the shared index: the Cursor Cloud
automation `index-context`** (`.cursor/automations/index-context.md`). Never
run `npm run index:cloud`, install `launchd/com.sherlock.context-index-sync.plist`,
or otherwise sync the index from a dev machine. In June 2026, two writers with
different corpus copies overwrote each other every ~30 minutes and a
partial-clone run deleted most of the index. Guardrails now exist (client
refuses >10% deletions; server rejects >20% without an explicit header;
empty manifests abort) — but the rule stands. Dev machines are **query-only**.

Emergency exception: if the remote index is empty/lost (check `/query/stats`)
and the cloud indexer is down, rebuild from a machine with a current
`sherlock-context` clone:
`SHERLOCK_CONTEXT_UPSERT_BATCH_SIZE=10 SHERLOCK_CONTEXT_BUILD_CONCURRENCY=8 npm run index:cloud`
(~7 min; safe — upserts only).

## Architecture map

- `src/retrieval/` — shared index: sqlite schema + search (`shared-index.ts`),
  HTTP server deployed to Render (`api-server.ts`), client (`api-client.ts`),
  chunking/embeddings (`build-document.ts`, `embeddings.ts` — Voyage voyage-3-lite)
- `src/scripts/cloud-index-sync.ts` — manifest-diff index sync (the thing only
  the cloud automation runs)
- `src/ingest/` — per-source ingestors (youtube, substack, twitter-people,
  blogs, twitter-bookmarks); run via `npm run ingest -- <source>`
- `src/bridge/` — iMessage bridge + researcher job manager (runs on the primary Mac)
- `src/admin/` — dashboard at http://127.0.0.1:18789 (`npm run admin`); reads
  corpus stats from the remote API only
- `.cursor/automations/*.md` — Cursor Cloud automation specs (ingest + indexing).
  These share the user's Cursor usage quota and die silently when it runs out.

## Primary-Mac-only components (launchd)

`com.sherlock.bridge`, `com.sherlock.admin`, `com.sherlock.context-sync`
(git-pulls sherlock-context every 60s), `com.sherlock.vault-sync`,
`com.sherlock.index-freshness` (12h read-only alarm: notifies if the API is
down, the index lost docs vs the local corpus, or content is >3 days stale).
Plists live in `launchd/`; do not install them on secondary machines.
Logs: `~/Library/Logs/sherlock-*.log` and `state/*.log`.

## Commands

- `npm run typecheck` / `npm test` — always typecheck before committing
- `npm run admin` — dashboard; `npm run bridge` — iMessage bridge
- `npm run check:freshness` — one-shot index health check (read-only)
- `npm run ingest -- <source>` — manual ingest (writes to ../sherlock-context)

## Operational history worth knowing

June 2026: (1) dual-writer index war + partial-clone wipe (fixed: single-writer
rule + guardrails, commit 3593cd5); (2) an unexplained Render platform-side
disk loss while no writers were alive — recovered by rebuild; a forced-restart
test confirmed the disk normally persists. Render's daily disk snapshots can
capture *post-loss* state; treat the git corpus, not snapshots, as the recovery
source. The index is derived data and self-heals: an empty index is fully
re-upserted by the next indexer cycle.
