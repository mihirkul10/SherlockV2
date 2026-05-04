#!/usr/bin/env bash
# M3 verification battery — researcher sub-agents + concurrency + reports.
# Requires: bridge running on 127.0.0.1:18790, M2 already verified.
set -uo pipefail
PASS=0
FAIL=0
check() { if [ "$1" = "OK" ]; then PASS=$((PASS+1)); echo "  ✓ $2"; else FAIL=$((FAIL+1)); echo "  ✗ $2 [$1]"; fi; }

PROJECT="$HOME/Projects/SherlockV2"
VAULT="$HOME/Projects/sherlock-vault"
PORT=18790

echo "=== V1: research-runs.sqlite exists with rows ==="
DB="$PROJECT/state/research-runs.sqlite"
if [ -f "$DB" ]; then
  rows=$(sqlite3 "$DB" "SELECT COUNT(*) FROM research_runs" 2>/dev/null)
  [ "${rows:-0}" -ge 1 ] && check OK "research-runs.sqlite has $rows rows" || check FAIL "research-runs empty"
else
  check FAIL "research-runs.sqlite missing"
fi

echo "=== V2: At least one report file in sherlock-vault/Reports ==="
report_count=$(find "$VAULT/Reports" -name '*.md' -not -name '_index.md' 2>/dev/null | wc -l | tr -d ' ')
[ "$report_count" -ge 1 ] && check OK "$report_count report file(s) in vault" || check FAIL "no report files"

echo "=== V3: Most recent report has valid frontmatter ==="
latest=$(find "$VAULT/Reports" -name '*.md' -not -name '_index.md' -print0 2>/dev/null | xargs -0 ls -t 2>/dev/null | head -1)
if [ -n "$latest" ]; then
  for required in "type: report" "research_id:" "title:" "scope:" "status:" "asked_at:" "finished_at:" "## TL;DR"; do
    grep -q "$required" "$latest" && check OK "report has '$required'" || check FAIL "report missing '$required'"
  done
else
  check FAIL "no report file to inspect"
fi

echo "=== V4: Report contains URL citations ==="
url_count=$(grep -cE 'https?://' "$latest" 2>/dev/null || echo 0)
[ "$url_count" -ge 3 ] && check OK "report has $url_count URL citations (>=3)" || check FAIL "report has $url_count URL citations"

echo "=== V5: Vault git history shows the report was committed + pushed ==="
ahead_behind=$(git -C "$VAULT" rev-list --left-right --count origin/main...HEAD 2>/dev/null || echo "?")
echo "  vault ahead/behind origin: $ahead_behind"
log_out=$(git -C "$VAULT" log --oneline -25 2>/dev/null)
echo "$log_out" | head -3 | sed 's/^/    /'
echo "$log_out" | grep -qiE '(report|research)' && check OK "git log shows research commit" || check FAIL "no research commit in git log"

echo "=== V6: Concurrency cap (=3) holds: 4 parallel inserts → 1 queued ==="
# Bash 3.2 compatible: use a temp file instead of mapfile.
TMP_IDS=$(mktemp)
for i in 1 2 3 4; do
  curl -sS -X POST "http://127.0.0.1:$PORT/research/start" \
    -H "Content-Type: application/json" \
    -d "{\"chat_guid\":\"verify-m3-cap-$i\",\"topic\":\"verify-m3 capacity probe $i\",\"urgency\":\"low\"}" \
    | python3 -c "import sys,json; r=json.load(sys.stdin); print(r.get('research_id'), r.get('status'), r.get('queue_position'))" 2>/dev/null >> "$TMP_IDS"
done
running_count=$(grep -c "running" "$TMP_IDS" 2>/dev/null | tr -d ' ')
queued_count=$(grep -c "queued" "$TMP_IDS" 2>/dev/null | tr -d ' ')
[ "${running_count:-0}" -eq 3 ] && [ "${queued_count:-0}" -eq 1 ] && check OK "3 running + 1 queued" || check FAIL "running=$running_count queued=$queued_count"

echo "=== V7: Cancel works on running researchers ==="
ok_count=0
while read -r line; do
  id=$(echo "$line" | awk '{print $1}')
  if [ -n "$id" ] && [ "$id" != "None" ]; then
    result=$(curl -sS -X POST "http://127.0.0.1:$PORT/research/$id/cancel" 2>/dev/null)
    echo "$result" | grep -q '"ok":true' && ok_count=$((ok_count+1))
  fi
done < "$TMP_IDS"
rm -f "$TMP_IDS"
[ "$ok_count" -eq 4 ] && check OK "all 4 cancels acknowledged" || check FAIL "$ok_count/4 cancels acknowledged"

sleep 2
echo "=== V8: Cap drains to 0 active after cancel ==="
state=$(curl -sS "http://127.0.0.1:$PORT/state" 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin)['research']; print(d['active_count'], d['queued_count'])")
echo "$state" | grep -qE '^0 0' && check OK "active=0 queued=0 after cancel" || check FAIL "state after cancel: $state"

echo
echo "=== M3 SUMMARY: $PASS pass, $FAIL fail ==="
exit $([ $FAIL -eq 0 ] && echo 0 || echo 1)
