#!/usr/bin/env bash
# sync-runner.sh — Trigger all available sync endpoints and record health
# Modified for macOS compatibility (Bash 3.2)
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_config.sh"

LOG="$SCRIPTS_DIR/sync-runner.log"
BASE_URL="$SKYNET_DEV_SERVER_URL"

# Ensure directories exist
mkdir -p "$(dirname "$LOG")"

cd "$PROJECT_DIR"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

# --- PID lock ---
LOCKFILE="${SKYNET_LOCK_PREFIX}-sync-runner.lock"
if [ -f "$LOCKFILE" ] && kill -0 "$(cat "$LOCKFILE")" 2>/dev/null; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Already running (PID $(cat "$LOCKFILE")). Exiting." >> "$LOG"
  exit 0
fi
echo $$ > "$LOCKFILE"
trap 'rm -f "$LOCKFILE"' EXIT

# --- Pre-flight: check if dev server is reachable ---
if ! curl -sf "$BASE_URL/api/admin/pipeline/status" > /dev/null 2>&1; then
  log "Dev server not reachable at $BASE_URL. SKIPPED."

  # Write SKIPPED to sync-health
  cat > "$SYNC_HEALTH" <<EOF
# Sync Health

_Last sync results per endpoint. Updated by sync-runner.sh._
_Last attempt: $(date '+%Y-%m-%d %H:%M') — SKIPPED (server unreachable)_

| Endpoint | Last Run | Status | Records | Notes |
|----------|----------|--------|---------|-------|
EOF

  # Add static entries
  if [ -n "${SKYNET_SYNC_STATIC+x}" ]; then
    for entry in "${SKYNET_SYNC_STATIC[@]}"; do
      echo "$entry" >> "$SYNC_HEALTH"
    done
  fi
  exit 0
fi

log "Server reachable. Starting syncs."
tg "🔄 *$SKYNET_PROJECT_NAME_UPPER SYNC-RUNNER* starting — syncing all endpoints"

# --- Run each sync endpoint ---
# Results stored as: name=status|records|notes
declare -a _sync_names=()
declare -a _sync_results=()

run_sync() {
  local name="$1"
  local endpoint="$2"

  log "Syncing: $name"

  # Capture both HTTP status code and response body
  local tmpfile="${SKYNET_LOCK_PREFIX}-sync-$name.tmp"
  local http_code
  http_code=$(curl -s --max-time 120 -o "$tmpfile" -w "%{http_code}" -X POST "$BASE_URL$endpoint" -H "Content-Type: application/json" 2>&1) || {
    log "$name: FAILED (curl error)"
    _sync_results+=("error|0|curl failed")
    rm -f "$tmpfile"
    return
  }
  local response
  response=$(cat "$tmpfile" 2>/dev/null || echo "")
  rm -f "$tmpfile"

  # Check HTTP status code first
  if [ "$http_code" -ge 300 ] 2>/dev/null; then
    log "$name: HTTP $http_code"
    _sync_results+=("error|0|HTTP $http_code")
    return
  fi

  # Check for HTML response (redirect to login or error page)
  if echo "$response" | grep -qi '<html\|<!DOCTYPE\|/login'; then
    log "$name: ERROR — Got HTML instead of JSON (login redirect or error page)"
    _sync_results+=("error|0|auth redirect or HTML error")
    return
  fi

  # Check for JSON error field (ignore "error":null which means no error)
  if echo "$response" | grep -qi '"error"' && ! echo "$response" | grep -qi '"error":null'; then
    local error_msg
    error_msg=$(echo "$response" | grep -o '"error":"[^"]*"' | head -1 | sed 's/"error":"//;s/"//')
    log "$name: ERROR — $error_msg"
    _sync_results+=("error|0|$error_msg")
    return
  fi

  log "$name: OK (HTTP $http_code)"
  _sync_results+=("ok|—|success")
}

# Iterate over configured sync endpoints
if [ -n "${SKYNET_SYNC_ENDPOINTS+x}" ]; then
  for entry in "${SKYNET_SYNC_ENDPOINTS[@]}"; do
    # Each entry is "name|endpoint" or "name|endpoint|optional"
    ep_name="" ep_path="" ep_optional=""
    IFS='|' read -r ep_name ep_path ep_optional <<< "$entry"
    _sync_names+=("$ep_name")

    if [ "$ep_optional" = "optional" ]; then
      # Only sync if the endpoint exists
      if curl -sf -X POST "$BASE_URL$ep_path" -H "Content-Type: application/json" > /dev/null 2>&1; then
        run_sync "$ep_name" "$ep_path"
      else
        _sync_results+=("pending|0|sync not built")
      fi
    else
      run_sync "$ep_name" "$ep_path"
    fi
  done
fi

# --- Write sync-health.md ---
now=$(date '+%Y-%m-%d %H:%M')

cat > "$SYNC_HEALTH" <<EOF
# Sync Health

_Last sync results per endpoint. Updated by sync-runner.sh._
_Last run: ${now}_

| Endpoint | Last Run | Status | Records | Notes |
|----------|----------|--------|---------|-------|
EOF

for i in "${!_sync_names[@]}"; do
  val="${_sync_results[$i]:-pending|0|unknown}"
  IFS='|' read -r status records notes <<< "$val"
  echo "| ${_sync_names[$i]} | $now | $status | $records | $notes |" >> "$SYNC_HEALTH"
done

# Add static entries
if [ -n "${SKYNET_SYNC_STATIC+x}" ]; then
  for entry in "${SKYNET_SYNC_STATIC[@]}"; do
    echo "$entry" >> "$SYNC_HEALTH"
  done
fi

# --- Check for errors and add to blockers if needed ---
has_errors=false
for i in "${!_sync_names[@]}"; do
  val="${_sync_results[$i]:-ok|0|}"
  IFS='|' read -r status records notes <<< "$val"
  if [ "$status" = "error" ]; then
    has_errors=true
    ep="${_sync_names[$i]}"
    # Only add to blockers if not already there
    if ! grep -q "$ep sync error" "$BLOCKERS" 2>/dev/null; then
      mkdir -p "$(dirname "$BLOCKERS")"
      touch "$BLOCKERS"
      echo "- **$(date '+%Y-%m-%d')**: $ep sync error — $notes" >> "$BLOCKERS"
    fi
  fi
done

if $has_errors; then
  log "Some syncs had errors. Check blockers.md."
  tg "⚠️ *$SKYNET_PROJECT_NAME_UPPER SYNC*: Some endpoints had errors. Check blockers.md"
else
  log "All available syncs completed OK."
  tg "🔄 *$SKYNET_PROJECT_NAME_UPPER SYNC*: All endpoints OK"
fi

log "Sync runner finished."
