#!/usr/bin/env bash
# Install SherlockV2 launchd jobs into ~/Library/LaunchAgents.
# Idempotent: unloads any existing instance before loading.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
TARGET="$HOME/Library/LaunchAgents"
mkdir -p "$TARGET"
mkdir -p "$HOME/Library/Logs"

JOBS=(
  "com.sherlock.context-sync"
  "com.sherlock.vault-sync"
)

for job in "${JOBS[@]}"; do
  src="$SCRIPT_DIR/$job.plist"
  dst="$TARGET/$job.plist"
  if [[ ! -f "$src" ]]; then
    echo "skip: $src not found"
    continue
  fi
  cp "$src" "$dst"
  launchctl unload "$dst" 2>/dev/null || true
  launchctl load "$dst"
  echo "✓ installed $job"
done

launchctl list | grep -E '^[0-9-]+\s+[0-9]+\s+com\.sherlock\.' || echo "(no com.sherlock.* jobs running yet)"
