# SherlockV2 cloud-agent base image.
# Referenced by .cursor/environment.json; used by every Cursor Cloud
# Automation (ingest-youtube, ingest-twitter-people, ingest-substack,
# ingest-blogs).
#
# Provides:
#   - node 22 + npm + corepack (matches package.json engines)
#   - git (Step 0 of every automation clones sherlock-context)
#   - python3 + make + g++ (better-sqlite3 native build, in case the
#     ingest scripts ever pull a transitive native dep)
#
# Per Cursor's setup docs: do NOT COPY the project source here.
# Cursor manages the working tree at runtime.

FROM node:22-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
        git \
        ca-certificates \
        python3 \
        make \
        g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
