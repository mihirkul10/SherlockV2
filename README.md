# SherlockV2

Cursor-native personal research analyst. Cloud-scheduled ingestion + local two-tier agent (orchestrator + on-demand researchers) writing Markdown reports to your Obsidian vault.

> Full design: see [the plan file](file:///Users/sherlockkulkarni/.cursor/plans/sherlockv2_cursor-native_plan_4760e458.plan.md).

## Three-repo architecture

| Repo | Purpose | Who writes |
|------|---------|------------|
| `SherlockV2` (this) | Code: bridge, agents, MCP tools, ingest scripts, Canvas | You / agent |
| `sherlock-context` | Raw normalized Markdown from cloud ingestion | Cloud agents only (firewalled) |
| `sherlock-vault` | Obsidian — reports + your notes | Local researchers + you |

## Three kinds of agents

1. **Cloud ingestion agents** (`.cursor/automations/ingest-*.md`) — Cursor Cloud Automations, scheduled, write to `sherlock-context`.
2. **Sherlock-Front** (`src/bridge/front-runner.ts`) — local SDK agent per iMessage turn. Always responsive. Delegates deep work.
3. **Sherlock-Researcher** (`src/bridge/researcher-runner.ts`) — local SDK sub-agents spawned on demand by Sherlock-Front. Capped at 3 concurrent. Write reports to `sherlock-vault/Reports/`.

## Quick start (after credentials are in `~/.sherlock/.env`)

```bash
npm install
npm run smoke:sdk         # validates CURSOR_API_KEY end-to-end
npm run resolve:youtube   # @handles -> UC channelIds for the 29-channel seed
npm run resolve:twitter   # @handles -> userIds for the 4-people seed
npm run seed:sources      # writes sherlock-context/_state/sources.json
npm run bridge:dev        # starts the iMessage <-> SDK bridge
```

## Required credentials

See [`.env.example`](.env.example) for the full list. Existing keys reused from prior Sherlock at `~/.sherlock/.env`. New for V2: `CURSOR_API_KEY`, `SHERLOCK_GITHUB_PAT`, `YOUTUBE_API_KEY`.

## Status

Under active development — see TODOs in the agent transcript for the M0–M4 milestone breakdown.
