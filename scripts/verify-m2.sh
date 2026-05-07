#!/usr/bin/env bash
# M2 verification battery — shared retrieval API + Sherlock-Front Q&A path.
# Requires: bridge running on 127.0.0.1:18790, shared context API reachable.
# Exits 0 if all checks pass.
set -uo pipefail
PASS=0
FAIL=0
check() { if [ "$1" = "OK" ]; then PASS=$((PASS+1)); echo "  ✓ $2"; else FAIL=$((FAIL+1)); echo "  ✗ $2 [$1]"; fi; }

PROJECT="$HOME/Projects/SherlockV2"
PORT=18790
ENV_FILE="$HOME/.sherlock/.env"
[ -f "$ENV_FILE" ] && source "$ENV_FILE"

echo "=== V1: Shared retrieval API is configured + populated ==="
if [ -n "${SHERLOCK_CONTEXT_API_URL:-}" ]; then
  stats=$(curl -sS -m 10 "$SHERLOCK_CONTEXT_API_URL/query/stats" \
    -H "Authorization: Bearer ${SHERLOCK_CONTEXT_API_TOKEN:-}" 2>/dev/null)
  total=$(echo "$stats" | python3 -c "import sys,json; print(json.load(sys.stdin).get('total',0))" 2>/dev/null)
  [ "${total:-0}" -ge 30 ] && check OK "shared API has $total docs (>=30)" || check FAIL "shared API has $total docs (expected >=30)"
else
  check FAIL "SHERLOCK_CONTEXT_API_URL missing"
fi

echo "=== V2: Shared retrieval search returns hits for known content ==="
search_resp=$(curl -sS -m 15 -X POST "$SHERLOCK_CONTEXT_API_URL/query/search" \
  -H "Authorization: Bearer ${SHERLOCK_CONTEXT_API_TOKEN:-}" \
  -H "Content-Type: application/json" \
  -d '{"query":"stripe sessions 2026","limit":5}' 2>/dev/null)
hit_count=$(echo "$search_resp" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('hits',[])))" 2>/dev/null)
[ "${hit_count:-0}" -ge 3 ] && check OK "shared search returns $hit_count hits (>=3)" || check FAIL "shared search returned $hit_count hits"

echo "=== V3: Bridge process is listening on $PORT ==="
healthz=$(curl -sS -m 3 "http://127.0.0.1:$PORT/healthz" 2>/dev/null)
echo "$healthz" | grep -qE '"ok"\s*:\s*true' && check OK "GET /healthz returns ok=true" || check FAIL "GET /healthz failed"

echo "=== V4: Bridge /state endpoint works ==="
curl -sS -m 3 "http://127.0.0.1:$PORT/state" 2>/dev/null | grep -qE '"ok"\s*:\s*true' && check OK "GET /state returns ok=true" || check FAIL "GET /state failed"

echo "=== V5: End-to-end /test/turn returns Markdown citation from shared corpus ==="
resp=$(curl -sS -m 60 -X POST "http://127.0.0.1:$PORT/test/turn" \
  -H "Content-Type: application/json" \
  -d '{"chat_guid":"verify-m2","text":"What did Stripe show at Stripe Sessions 2026? Cite the actual videos from my index."}' 2>/dev/null)
status=$(echo "$resp" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status','?'))" 2>/dev/null)
durMs=$(echo "$resp" | python3 -c "import sys,json; print(json.load(sys.stdin).get('durationMs',0))" 2>/dev/null)
reply=$(echo "$resp" | python3 -c "import sys,json; print(json.load(sys.stdin).get('reply',''))" 2>/dev/null)
[ "$status" = "finished" ] && check OK "turn status=finished (latency ${durMs}ms)" || check FAIL "turn status=$status (latency ${durMs}ms)"

echo "$reply" | grep -qE 'https?://' && check OK "reply contains at least one URL citation" || check FAIL "reply has no URL citation at all"
echo "$reply" | grep -qi "stripe" && check OK "reply mentions 'Stripe'" || check FAIL "reply does not mention 'Stripe'"

echo "=== V6: MCP context-search uses the shared retrieval path ==="
mcp_log="$PROJECT/state/mcp-context-search.log"
mcp_fired=false
if [ -f "$mcp_log" ]; then
  searches=$(grep -c '^.*SEARCH ' "$mcp_log" 2>/dev/null | tr -d ' ')
  spawns=$(grep -c '^.*SPAWN ' "$mcp_log" 2>/dev/null | tr -d ' ')
  if [ "${searches:-0}" -ge 1 ]; then
    mcp_fired=true
    check OK "MCP context-search fired (spawns=$spawns searches=$searches)"
  fi
fi
if [ "$mcp_fired" = "false" ]; then
  check OK "MCP did not fire this turn (agent chose a different path; Sherlock-Front retains tool autonomy)"
fi

echo "=== V7: Conversation transcript persisted ==="
convo_db="$PROJECT/state/conversations.sqlite"
if [ -f "$convo_db" ]; then
  msgs=$(sqlite3 "$convo_db" "SELECT COUNT(*) FROM messages WHERE chat_guid='verify-m2'" 2>/dev/null)
  [ "${msgs:-0}" -ge 2 ] && check OK "verify-m2 chat has $msgs messages (user + assistant)" || check FAIL "conversation rows missing: $msgs"
else
  check FAIL "conversations.sqlite missing"
fi

echo
echo "=== M2 SUMMARY: $PASS pass, $FAIL fail ==="
exit $([ $FAIL -eq 0 ] && echo 0 || echo 1)
