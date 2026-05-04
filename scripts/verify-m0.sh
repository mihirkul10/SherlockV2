#!/usr/bin/env bash
# M0 verification battery — re-runnable acceptance check.
# Exits 0 if all checks pass, 1 if any fail.
set -uo pipefail
PASS=0
FAIL=0
check() { if [ "$1" = "OK" ]; then PASS=$((PASS+1)); echo "  ✓ $2"; else FAIL=$((FAIL+1)); echo "  ✗ $2 [$1]"; fi; }

ENV_FILE="$HOME/.sherlock/.env"

echo "=== V1: GitHub repos exist + private ==="
for r in SherlockV2 sherlock-context sherlock-vault; do
  v=$(gh repo view "mihirkul10/$r" --json visibility -q .visibility 2>/dev/null || echo "MISSING")
  [ "$v" = "PRIVATE" ] && check OK "mihirkul10/$r is private" || check "$v" "mihirkul10/$r missing or not private"
done

echo "=== V2: Local clones on main + clean ==="
for d in "$HOME/Projects/sherlock-context" "$HOME/Projects/sherlock-vault"; do
  if [ -d "$d/.git" ]; then
    cd "$d"
    branch=$(git branch --show-current)
    dirty=$(git status --porcelain | wc -l | tr -d ' ')
    [ "$branch" = "main" ] && [ "$dirty" -eq 0 ] && check OK "$d on main, clean" || check FAIL "$d branch=$branch dirty=$dirty"
  else
    check FAIL "$d not a git repo"
  fi
done

echo "=== V3: sources.json roster integrity ==="
SOURCES="$HOME/Projects/sherlock-context/_state/sources.json"
result=$(python3 -c "
import json
d = json.load(open('$SOURCES'))
yt = len(d['youtube']['channels'])
tw = len(d['twitter']['people'])
bk = d['twitter'].get('bookmarks', {})
placeholders = [c for c in d['youtube']['channels'] if '_resolved' in c.get('channelId','')]
ok = yt == 29 and tw == 4 and bk.get('userId') == '1894831531' and len(placeholders) == 0
print('OK' if ok else f'FAIL yt={yt} tw={tw} bk_user={bk.get(\"handle\")} placeholders={len(placeholders)}')
" 2>&1)
check "$result" "29 YT + 4 TW + bookmarks @mihirkul10, 0 placeholders"

echo "=== V4: All 5 per-source state files exist + valid JSON ==="
for f in youtube substack twitter-people twitter-bookmarks blogs; do
  p="$HOME/Projects/sherlock-context/_state/${f}-state.json"
  if [ -f "$p" ] && python3 -c "import json; json.load(open('$p'))" 2>/dev/null; then
    check OK "${f}-state.json valid"
  else
    check FAIL "${f}-state.json missing or invalid"
  fi
done

echo "=== V5: launchd jobs registered ==="
for j in com.sherlock.context-sync com.sherlock.vault-sync; do
  if launchctl list | grep -q "$j"; then check OK "$j registered"; else check FAIL "$j not registered"; fi
done

echo "=== V6: launchd logs exist (proves jobs ran) ==="
for log in "$HOME/Library/Logs/sherlock-context-sync.log" "$HOME/Library/Logs/sherlock-vault-sync.log"; do
  if [ -f "$log" ]; then check OK "$(basename $log) exists"; else check FAIL "$(basename $log) missing"; fi
done

echo "=== V7: Round-trip git push (write -> push -> fresh clone reads it) ==="
cd "$HOME/Projects/sherlock-context"
PING="verify-m0 ping $(date -u +%FT%TZ)"
echo "$PING" >> _runs/verify.log && \
  git add _runs/verify.log && \
  git -c user.email=mihirkul10@gmail.com -c user.name="Sherlock Agent" commit -m "verify(m0): ping" --quiet && \
  git push --quiet 2>/dev/null && \
  rm -rf /tmp/sherlock-context-roundtrip && \
  git clone --quiet --depth 1 https://github.com/mihirkul10/sherlock-context.git /tmp/sherlock-context-roundtrip && \
  grep -q "$PING" /tmp/sherlock-context-roundtrip/_runs/verify.log && check OK "git round-trip" || check FAIL "git round-trip"
rm -rf /tmp/sherlock-context-roundtrip

echo "=== V8: PARALLEL_API_KEY validates ==="
PK=$(grep '^PARALLEL_API_KEY=' "$ENV_FILE" | cut -d= -f2-)
status=$(curl -sS -o /dev/null -w "%{http_code}" "https://api.parallel.ai/v1/search" -H "x-api-key: $PK" -X POST -H "Content-Type: application/json" -d '{"objective":"hello","search_queries":["test"]}' --max-time 10)
[ "$status" = "200" ] && check OK "Parallel API HTTP $status" || check FAIL "Parallel API HTTP $status"

echo "=== V9: APIFY_API_TOKEN validates ==="
AT=$(grep '^APIFY_API_TOKEN=' "$ENV_FILE" | cut -d= -f2-)
user=$(curl -sS "https://api.apify.com/v2/users/me?token=$AT" --max-time 10 | python3 -c "import sys,json; print(json.load(sys.stdin).get('data',{}).get('username','?'))" 2>/dev/null)
[ "$user" = "mihirkul10" ] && check OK "Apify user $user" || check FAIL "Apify user $user"

echo "=== V10: SDK smoke (local + cloud) ==="
cd "$HOME/Projects/SherlockV2"
SHERLOCKV2_REPO_URL=https://github.com/mihirkul10/SherlockV2 npm run smoke:sdk 2>&1 | grep -q "SDK smoke PASSED" && check OK "SDK smoke passed (local + cloud)" || check FAIL "SDK smoke failed"

echo
echo "=== M0 SUMMARY: $PASS pass, $FAIL fail ==="
exit $([ $FAIL -eq 0 ] && echo 0 || echo 1)
