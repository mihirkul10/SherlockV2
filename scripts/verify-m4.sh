#!/usr/bin/env bash
# M4 verification battery — paste-URL onboarding + all 4 ingestor paths + shared corpus presence.
# Requires: bridge running on 127.0.0.1:18790 for the URL-onboarding test.
set -uo pipefail
PASS=0
FAIL=0
check() { if [ "$1" = "OK" ]; then PASS=$((PASS+1)); echo "  ✓ $2"; else FAIL=$((FAIL+1)); echo "  ✗ $2 [$1]"; fi; }

PROJECT="$HOME/Projects/SherlockV2"
CONTEXT="$HOME/Projects/sherlock-context"
PORT=18790
ENV_FILE="$HOME/.sherlock/.env"
[ -f "$ENV_FILE" ] && source "$ENV_FILE"

echo "=== V1: All 4 ingestor cloud-automation prompt files exist ==="
for a in ingest-youtube ingest-twitter-people ingest-substack ingest-blogs; do
  [ -f "$PROJECT/.cursor/automations/$a.md" ] && check OK "$a.md present" || check FAIL "$a.md missing"
done

echo "=== V2: All 4 ingestor source modules exist ==="
for f in src/ingest/youtube.ts src/ingest/twitter-people.ts src/ingest/substack.ts src/ingest/blogs.ts; do
  [ -f "$PROJECT/$f" ] && check OK "$f present" || check FAIL "$f missing"
done

echo "=== V3: Sources MCP + URL resolver present ==="
for f in src/tools/sources/server.ts src/shared/url-resolver.ts src/ingest/resolvers.ts; do
  [ -f "$PROJECT/$f" ] && check OK "$f present" || check FAIL "$f missing"
done

echo "=== V4: Tweets ingested (>= 50 across all handles) ==="
tweet_count=$(find "$CONTEXT/_raw/twitter/people" -name '*.md' 2>/dev/null | wc -l | tr -d ' ')
[ "${tweet_count:-0}" -ge 50 ] && check OK "$tweet_count tweets ingested" || check FAIL "only $tweet_count tweets"

echo "=== V5: Blog feed ingested (Platformer added via paste-URL flow) ==="
blog_count=$(find "$CONTEXT/_raw/blogs" -name '*.md' 2>/dev/null | wc -l | tr -d ' ')
[ "${blog_count:-0}" -ge 5 ] && check OK "$blog_count blog posts" || check FAIL "only $blog_count blog posts"

echo "=== V6: sources.json includes the auto-added Platformer ==="
python3 -c "
import json
d = json.load(open('$CONTEXT/_state/sources.json'))
has_blog = any('platformer' in (f.get('url','') or '').lower() for f in d['blogs']['feeds'])
print('OK' if has_blog else 'FAIL')
" | grep -q OK && check OK "Platformer present in sources.json blogs[]" || check FAIL "Platformer not in sources.json"

echo "=== V7: Shared API sees all 3 source types ==="
counts=$(curl -sS -m 15 "$SHERLOCK_CONTEXT_API_URL/query/stats" \
  -H "Authorization: Bearer ${SHERLOCK_CONTEXT_API_TOKEN:-}" 2>/dev/null \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(' '.join(f'{k}={v}' for k,v in sorted(d.get('bySource',{}).items())))")
echo "  → $counts"
echo "$counts" | grep -q "youtube=" && echo "$counts" | grep -q "twitter-people=" && echo "$counts" | grep -q "blog=" \
  && check OK "shared API has youtube + twitter-people + blog rows" || check FAIL "shared API missing some source types"

echo "=== V8: Cross-source shared search returns hits from multiple source types ==="
hits=$(curl -sS -m 15 -X POST "$SHERLOCK_CONTEXT_API_URL/query/search" \
  -H "Authorization: Bearer ${SHERLOCK_CONTEXT_API_TOKEN:-}" \
  -H "Content-Type: application/json" \
  -d '{"query":"ai","limit":10}' 2>/dev/null \
  | python3 -c "import sys,json; data=json.load(sys.stdin); print(len({h.get('source') for h in data.get('hits',[]) if h.get('source')}))")
[ "${hits:-0}" -ge 2 ] && check OK "'ai' query returns hits from $hits distinct source types" || check FAIL "cross-source query returned $hits"

echo "=== V9: Primary launchd plists present ==="
for p in com.sherlock.admin com.sherlock.context-sync com.sherlock.context-index-sync com.sherlock.vault-sync com.sherlock.bridge; do
  [ -f "$PROJECT/launchd/$p.plist" ] && check OK "$p.plist present" || check FAIL "$p.plist missing"
done

echo "=== V10: Admin canvas present at workspace canvases path ==="
canvas_path="$HOME/.cursor/projects/Users-sherlockkulkarni-Projects-SherlockV2/canvases/admin.canvas.tsx"
[ -f "$canvas_path" ] && check OK "admin.canvas.tsx in canvases/" || check FAIL "admin canvas missing"

echo "=== V11: README + ops runbook present with non-trivial content ==="
readme="$PROJECT/README.md"
if [ -f "$readme" ]; then
  lines=$(wc -l < "$readme" | tr -d ' ')
  [ "$lines" -ge 80 ] && check OK "README has $lines lines (>=80)" || check FAIL "README only $lines lines"
else
  check FAIL "README.md missing"
fi

echo "=== V12: End-to-end paste-URL adds a source through Front (live, requires bridge) ==="
if curl -sS -m 3 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
  resp=$(curl -sS -m 60 -X POST "http://127.0.0.1:$PORT/test/turn" \
    -H "Content-Type: application/json" \
    -d '{"chat_guid":"verify-m4-end","text":"add this source: https://stratechery.com"}' 2>/dev/null)
  status=$(echo "$resp" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status','?'))" 2>/dev/null)
  reply=$(echo "$resp" | python3 -c "import sys,json; print(json.load(sys.stdin).get('reply',''))" 2>/dev/null)
  if [ "$status" = "finished" ]; then
    if echo "$reply" | grep -qiE "(stratechery|already tracked|added)"; then
      check OK "Front responded coherently to paste-URL"
    else
      check FAIL "Front replied finished but reply doesn't mention the source"
    fi
  else
    check FAIL "turn status=$status"
  fi
else
  echo "  (skipped — bridge not running on :$PORT)"
fi

echo
echo "=== M4 SUMMARY: $PASS pass, $FAIL fail ==="
exit $([ $FAIL -eq 0 ] && echo 0 || echo 1)
