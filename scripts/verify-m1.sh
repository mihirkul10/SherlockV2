#!/usr/bin/env bash
# M1 verification battery — ingest path acceptance check.
# Exits 0 if all checks pass, 1 if any fail.
set -uo pipefail
PASS=0
FAIL=0
check() { if [ "$1" = "OK" ]; then PASS=$((PASS+1)); echo "  ✓ $2"; else FAIL=$((FAIL+1)); echo "  ✗ $2 [$1]"; fi; }

CONTEXT="$HOME/Projects/sherlock-context"

echo "=== V1: Markdown files exist for both test channels ==="
stripe_count=$(ls "$CONTEXT/_raw/youtube/stripe/" 2>/dev/null | wc -l | tr -d ' ')
a16z_count=$(ls "$CONTEXT/_raw/youtube/a16zcrypto/" 2>/dev/null | wc -l | tr -d ' ')
[ "$stripe_count" -ge 5 ] && check OK "stripe: $stripe_count files" || check FAIL "stripe: $stripe_count files (<5)"
[ "$a16z_count" -ge 5 ] && check OK "a16zcrypto: $a16z_count files" || check FAIL "a16zcrypto: $a16z_count files (<5)"

echo "=== V2: Frontmatter integrity (sample) ==="
sample=$(ls "$CONTEXT/_raw/youtube/stripe/"*.md 2>/dev/null | head -1)
if [ -n "$sample" ]; then
  for required in "source: youtube" "source_id: UC" "content_id:" "url:" "author:" "published_at:" "ingested_at:" "title:" "transcript_status:"; do
    grep -q "$required" "$sample" && check OK "frontmatter has '$required'" || check FAIL "frontmatter missing '$required'"
  done
else
  check FAIL "no sample file to inspect"
fi

echo "=== V3: Transcript success rate >= 90% ==="
total=$(find "$CONTEXT/_raw/youtube" -name '*.md' | wc -l | tr -d ' ')
ok=$(grep -l "transcript_status: ok" $(find "$CONTEXT/_raw/youtube" -name '*.md') 2>/dev/null | wc -l | tr -d ' ')
if [ "$total" -gt 0 ]; then
  pct=$((ok * 100 / total))
  [ "$pct" -ge 90 ] && check OK "transcript success $ok/$total ($pct%)" || check FAIL "transcript success $ok/$total ($pct%)"
else
  check FAIL "no markdown files to check"
fi

echo "=== V4: Idempotency — re-run produces 0 new files ==="
cd "$HOME/Projects/SherlockV2"
before=$(find "$CONTEXT/_raw/youtube" -name '*.md' | wc -l | tr -d ' ')
result=$(npm run ingest -- youtube --handle @stripe 2>&1 | grep -E 'totalNew|fresh' | head -2)
after=$(find "$CONTEXT/_raw/youtube" -name '*.md' | wc -l | tr -d ' ')
[ "$before" -eq "$after" ] && check OK "idempotent: $before -> $after files" || check FAIL "idempotent broken: $before -> $after files"

echo "=== V5: youtube-state.json knownVideoIds populated ==="
state="$CONTEXT/_state/youtube-state.json"
known_count=$(python3 -c "import json; d=json.load(open('$state')); print(sum(len(v.get('knownVideoIds',[])) for v in d.values()))")
[ "$known_count" -ge 30 ] && check OK "knownVideoIds tracked: $known_count entries" || check FAIL "knownVideoIds: $known_count (expected >=30)"

echo "=== V6: ingest-runs.ndjson has entries ==="
runs_log="$CONTEXT/_runs/ingest-runs.ndjson"
runs_count=$(wc -l < "$runs_log" 2>/dev/null | tr -d ' ')
[ "$runs_count" -ge 2 ] && check OK "ingest-runs.ndjson has $runs_count rows" || check FAIL "ingest-runs.ndjson has $runs_count rows (expected >=2)"

echo "=== V7: Apify spend tracked + reasonable ==="
AT=$(grep '^APIFY_API_TOKEN=' "$HOME/.sherlock/.env" | cut -d= -f2-)
spend=$(curl -sS "https://api.apify.com/v2/users/me/usage/monthly?token=$AT" --max-time 10 | python3 -c "import sys,json; print(round(float(json.load(sys.stdin).get('data',{}).get('totalUsageCreditsUsdAfterVolumeDiscount',0)), 4))" 2>/dev/null)
echo "  → month-to-date Apify spend: \$$spend"
ok=$(python3 -c "print('OK' if $spend < 5.0 else 'FAIL')")
check "$ok" "Apify spend under \$5 ($spend)"

echo
echo "=== M1 SUMMARY: $PASS pass, $FAIL fail ==="
exit $([ $FAIL -eq 0 ] && echo 0 || echo 1)
