# Render deployment for `context:api`

This is the permanent hosted setup for Sherlock's shared retrieval API.

## Goal

Move the shared retrieval service and its SQLite-backed shared index off the
Mac so that:

- the cloud indexing automation can keep updating the index while the laptop is off
- Sherlock-Front and Sherlock-Researcher query the same always-on shared index
- starting Sherlock from the admin portal only needs the local user-facing services

## What is already prepared in the repo

- `render.yaml` declares a Render web service named `sherlock-context-api`
- `src/retrieval/api-server.ts` now respects Render's injected `PORT`
- the service stores the shared index at `/data/shared-index.sqlite`
- health checks use `/healthz`

## What to create in Render

Create a new Blueprint / infrastructure-as-code deployment from this repo using
the root `render.yaml`.

The resulting Render web service should be:

- **name**: `sherlock-context-api`
- **runtime**: Node
- **plan**: Starter or higher (persistent disks require a paid plan)
- **disk mount**: `/data`
- **SQLite file**: `/data/shared-index.sqlite`

## Secrets to enter in Render

Render will prompt you for:

- `SHERLOCK_CONTEXT_API_TOKEN`
- `VOYAGE_API_KEY`

Use the same `SHERLOCK_CONTEXT_API_TOKEN` that the cloud index agent and local
Sherlock Mac use.

## After first deploy

Render will assign a stable HTTPS URL like:

`https://sherlock-context-api.onrender.com`

Use that exact URL as:

- local Mac: `SHERLOCK_CONTEXT_API_URL`
- Cursor Cloud `index-context` automation: `SHERLOCK_CONTEXT_API_URL`

## Cursor Cloud `index-context` automation values

- `SHERLOCK_CONTEXT_API_URL=https://<your-render-host>`
- `SHERLOCK_CONTEXT_API_TOKEN=<same token as Render>`
- `SHERLOCK_CONTEXT_PATH=../sherlock-context`
- `SHERLOCK_GITHUB_PAT=<existing PAT>`
- `VOYAGE_API_KEY=<same voyage key>`
- `CURSOR_API_KEY=<existing cursor key>`

## Local Sherlock Mac values after deploy

Update `~/.sherlock/.env`:

- `SHERLOCK_CONTEXT_API_URL=https://<your-render-host>`
- `SHERLOCK_CONTEXT_API_TOKEN=<same token as Render>`

Then restart Sherlock services from the admin portal or reload launchd.

## Recommended local runtime after successful cutover

Once the hosted Render service is healthy and Sherlock is pointed at it:

- do not run a separate local `com.sherlock.context-api` service in normal operation
- do not rely on any local SQLite retrieval fallback path
- keep `com.sherlock.context-sync` enabled so the Mac sees fresh raw corpus pulls
- keep `com.sherlock.context-index-sync` enabled if you want the Mac to push pulled raw changes into the shared API between cloud indexer runs

The intended runtime model is remote-only retrieval: Front, Researcher, and the
admin surfaces should all treat the hosted shared API as the single searchable
corpus backend.
