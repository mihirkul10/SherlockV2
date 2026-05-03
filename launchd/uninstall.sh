#!/usr/bin/env bash
# Unload + remove all SherlockV2 launchd jobs.
set -euo pipefail

TARGET="$HOME/Library/LaunchAgents"
JOBS=(
  "com.sherlock.context-sync"
  "com.sherlock.vault-sync"
  "com.sherlock.bridge"
  "com.sherlock.indexer"
)

for job in "${JOBS[@]}"; do
  dst="$TARGET/$job.plist"
  if [[ -f "$dst" ]]; then
    launchctl unload "$dst" 2>/dev/null || true
    rm -f "$dst"
    echo "✓ removed $job"
  fi
done
