#!/usr/bin/env bash
# post-merge-smoke.sh — Hit API routes to verify runtime health after merge
# Usage: bash scripts/post-merge-smoke.sh [base_url]
# Returns: 0 if all endpoints healthy, 1 if any fail
# Skips gracefully if dev server is not reachable (exit 0).

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_config.sh"

BASE_URL="${1:-${SKYNET_DEV_SERVER_URL:-http://localhost:3000}}"
TIMEOUT="${SKYNET_SMOKE_TIMEOUT:-10}"
LOG="$SCRIPTS_DIR/post-merge-smoke.log"
TMPFILE="/tmp/skynet-smoke-body-$$"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

rotate_log_if_needed "$LOG"

# Pre-flight: is the server reachable?
if ! curl -sf --max-time 5 "$BASE_URL" >/dev/null 2>&1; then
  log "Dev server not reachable at $BASE_URL — skipping smoke test"
  exit 0
fi

# Endpoints to validate (GET only — safe, no mutations)
ENDPOINTS="
/api/admin/pipeline/status
/api/admin/tasks
/api/admin/monitoring/status
/api/admin/monitoring/agents
/api/admin/mission/status
/api/admin/events
/api/admin/config
/api/admin/prompts
"

failed=0
total=0

for endpoint in $ENDPOINTS; do
  [ -z "$endpoint" ] && continue
  total=$((total + 1))

  http_code=$(curl -sf --max-time "$TIMEOUT" -w "%{http_code}" -o "$TMPFILE" "$BASE_URL$endpoint" 2>/dev/null) || http_code="000"

  if [ "$http_code" != "200" ]; then
    log "FAIL: $endpoint → HTTP $http_code"
    failed=$((failed + 1))
    continue
  fi

  # Validate JSON envelope: must contain "data" and "error" keys
  if ! grep -q '"data"' "$TMPFILE" 2>/dev/null || ! grep -q '"error"' "$TMPFILE" 2>/dev/null; then
    log "FAIL: $endpoint → invalid response shape (missing data/error)"
    failed=$((failed + 1))
    continue
  fi

  log "PASS: $endpoint"
done

rm -f "$TMPFILE"

if [ "$failed" -gt 0 ]; then
  log "Smoke test: $failed/$total endpoints failed"
  exit 1
else
  log "Smoke test: all $total endpoints passed"
  exit 0
fi
