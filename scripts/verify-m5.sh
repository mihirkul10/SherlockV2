#!/usr/bin/env bash
# M5 verification battery — shared retrieval API + cloud index sync.
set -uo pipefail
PASS=0
FAIL=0
check() { if [ "$1" = "OK" ]; then PASS=$((PASS+1)); echo "  ✓ $2"; else FAIL=$((FAIL+1)); echo "  ✗ $2 [$1]"; fi; }

PROJECT="$HOME/Projects/SherlockV2"
PORT="${SHERLOCK_CONTEXT_API_PORT:-18841}"
TOKEN="verify-shared-index-token"
TMP_DB="$(mktemp "$PROJECT/state/shared-index.verify.XXXXXX.sqlite")"
API_LOG="$(mktemp "$PROJECT/state/context-api.verify.XXXXXX.log")"

cleanup() {
  if [ -n "${API_PID:-}" ] && kill -0 "$API_PID" 2>/dev/null; then
    kill "$API_PID" 2>/dev/null || true
    wait "$API_PID" 2>/dev/null || true
  fi
  rm -f "$TMP_DB" "$API_LOG"
}
trap cleanup EXIT

echo "=== V1: Start shared retrieval API on a temp DB ==="
(
  cd "$PROJECT" || exit 1
  SHERLOCK_CONTEXT_API_PORT="$PORT" \
  SHERLOCK_CONTEXT_API_TOKEN="$TOKEN" \
  SHERLOCK_SHARED_INDEX_DB="$TMP_DB" \
  npm run context:api
) >"$API_LOG" 2>&1 &
API_PID=$!
started=false
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -sS -m 3 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
    started=true
    break
  fi
  sleep 1
done
if [ "$started" = "true" ]; then
  check OK "shared retrieval API started on $PORT"
else
  check FAIL "shared retrieval API did not start"
fi

echo "=== V2: Cloud index sync can push the local corpus into the shared API ==="
(
  cd "$PROJECT" || exit 1
  SHERLOCK_CONTEXT_API_URL="http://127.0.0.1:$PORT" \
  SHERLOCK_CONTEXT_API_TOKEN="$TOKEN" \
  npm run index:cloud
) >/dev/null 2>&1
sync_code=$?
[ "$sync_code" -eq 0 ] && check OK "npm run index:cloud exited 0" || check FAIL "npm run index:cloud exited $sync_code"

echo "=== V3: Shared API stats show indexed docs ==="
stats=$(curl -sS -m 10 "http://127.0.0.1:$PORT/query/stats" -H "Authorization: Bearer $TOKEN" 2>/dev/null)
total=$(echo "$stats" | python3 -c "import sys,json; print(json.load(sys.stdin).get('total',0))" 2>/dev/null)
[ "${total:-0}" -ge 1 ] && check OK "shared API reports $total indexed docs" || check FAIL "shared API reports $total indexed docs"

echo "=== V4: Shared search returns hits ==="
search_resp=$(curl -sS -m 15 -X POST "http://127.0.0.1:$PORT/query/search" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"stripe sessions 2026","limit":5}' 2>/dev/null)
search_hits=$(echo "$search_resp" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('hits',[])))" 2>/dev/null)
[ "${search_hits:-0}" -ge 1 ] && check OK "shared search returned $search_hits hits" || check FAIL "shared search returned $search_hits hits"

echo "=== V5: Shared brief produces a summary ==="
brief_resp=$(curl -sS -m 15 -X POST "http://127.0.0.1:$PORT/query/brief" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"topic":"stripe sessions 2026","limit":6}' 2>/dev/null)
brief_summary=$(echo "$brief_resp" | python3 -c "import sys,json; print(json.load(sys.stdin).get('summary',''))" 2>/dev/null)
[ -n "$brief_summary" ] && check OK "brief returned a non-empty summary" || check FAIL "brief summary empty"

echo "=== V6: Shared followups produce a backend handoff note ==="
follow_resp=$(curl -sS -m 15 -X POST "http://127.0.0.1:$PORT/query/followups" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"topic":"stripe sessions 2026","user_question":"What matters here for product strategy?","limit":6}' 2>/dev/null)
follow_count=$(echo "$follow_resp" | python3 -c "import sys,json; data=json.load(sys.stdin); print(len(data.get('questions',[])))" 2>/dev/null)
handoff_note=$(echo "$follow_resp" | python3 -c "import sys,json; print(json.load(sys.stdin).get('handoff_note',''))" 2>/dev/null)
[ "${follow_count:-0}" -ge 1 ] && check OK "followups returned $follow_count question(s)" || check FAIL "followups returned $follow_count question(s)"
[ -n "$handoff_note" ] && check OK "followups returned a handoff note" || check FAIL "followups missing handoff note"

echo
echo "=== M5 SUMMARY: $PASS pass, $FAIL fail ==="
exit $([ $FAIL -eq 0 ] && echo 0 || echo 1)
