#!/usr/bin/env bash
# sync-runner.sh — Trigger all available sync endpoints and record health
# Modified for macOS compatibility (Bash 3.2)
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_config.sh"

LOG="$LOG_DIR/sync-runner.log"
BASE_URL="$SKYNET_DEV_SERVER_URL"

# Ensure directories exist
mkdir -p "$(dirname "$LOG")"

cd "$PROJECT_DIR"

log() { _log "info" "SYNC" "$*" "$LOG"; _log "info" "SYNC" "$*"; }

# Guard: validate SKYNET_SYNC_ENDPOINTS is defined and is an array with elements
# SH-P2-6: Use declare -p check to verify it is actually an array
# SH-P3-3: bash 3.2 compat — use +x test instead of ${#array[@]} for empty check
if [ -z "${SKYNET_SYNC_ENDPOINTS+x}" ]; then
  log "WARNING: SKYNET_SYNC_ENDPOINTS is not defined"
  exit 0
fi
if ! declare -p SKYNET_SYNC_ENDPOINTS 2>/dev/null | grep -q 'declare -a'; then
  log "WARNING: SKYNET_SYNC_ENDPOINTS is not an array — check skynet.config.sh"
  exit 0
fi
# bash 3.2 safe empty array check: count elements via for-loop
_sync_count=0
for _ep in "${SKYNET_SYNC_ENDPOINTS[@]}"; do _sync_count=$((_sync_count + 1)); done
if [ "$_sync_count" -eq 0 ]; then
  log "WARNING: SKYNET_SYNC_ENDPOINTS is empty"
  exit 0
fi

# --- PID lock (shared helper from _locks.sh via _config.sh) ---
LOCKFILE="${SKYNET_LOCK_PREFIX}-sync-runner.lock"

if ! acquire_worker_lock "$LOCKFILE" "$LOG" "SYNC"; then
  exit 0
fi
_sync_runner_cleanup() {
  release_lock_if_owned "$LOCKFILE" "$$" 2>/dev/null || true
}
trap '_sync_runner_cleanup' EXIT
trap '_sync_runner_cleanup; exit 130' INT
trap '_sync_runner_cleanup; exit 143' TERM

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
  local max_attempts=3
  local backoff=2  # seconds; doubles each retry: 2s, 4s

  log "Syncing: $name"

  local attempt=1
  local http_code="" response="" curl_failed=false

  while [ "$attempt" -le "$max_attempts" ]; do
    curl_failed=false

    # Capture both HTTP status code and response body
    local tmpfile
    tmpfile=$(mktemp "/tmp/skynet-${SKYNET_PROJECT_NAME}-sync-${name}-XXXXXX")
    http_code=$(curl -s --max-time 120 -o "$tmpfile" -w "%{http_code}" -X POST "$BASE_URL$endpoint" -H "Content-Type: application/json" 2>&1) || {
      curl_failed=true
    }
    response=$(cat "$tmpfile" 2>/dev/null || echo "")
    rm -f "$tmpfile"

    # Determine if this is a transient failure worth retrying
    local transient=false
    if $curl_failed; then
      transient=true
    elif [ "$http_code" -ge 500 ] 2>/dev/null; then
      transient=true
    fi

    # If not transient, break out — no point retrying
    if ! $transient; then
      break
    fi

    # Log the transient failure
    if $curl_failed; then
      log "$name: curl error (attempt $attempt/$max_attempts)"
    else
      log "$name: HTTP $http_code (attempt $attempt/$max_attempts)"
    fi

    # Retry with exponential backoff if attempts remain
    if [ "$attempt" -lt "$max_attempts" ]; then
      log "$name: retrying in ${backoff}s..."
      sleep "$backoff"
      backoff=$((backoff * 2))
    fi
    attempt=$((attempt + 1))
  done

  # --- Evaluate final result ---

  if $curl_failed; then
    log "$name: FAILED (curl error after $max_attempts attempts)"
    _sync_results+=("error|0|curl failed")
    return
  fi

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

_i=0
while [ $_i -lt ${#_sync_names[@]} ]; do
  val="${_sync_results[$_i]:-pending|0|unknown}"
  IFS='|' read -r status records notes <<< "$val"
  echo "| ${_sync_names[$_i]} | $now | $status | $records | $notes |" >> "$SYNC_HEALTH"
  _i=$((_i + 1))
done

# Add static entries
if [ -n "${SKYNET_SYNC_STATIC+x}" ]; then
  for entry in "${SKYNET_SYNC_STATIC[@]}"; do
    echo "$entry" >> "$SYNC_HEALTH"
  done
fi

# --- Check for errors and add to blockers if needed ---
has_errors=false
_i=0
while [ $_i -lt ${#_sync_names[@]} ]; do
  val="${_sync_results[$_i]:-ok|0|}"
  IFS='|' read -r status records notes <<< "$val"
  if [ "$status" = "error" ]; then
    has_errors=true
    ep="${_sync_names[$_i]}"
    # Only add to blockers if not already there
    if ! grep -q "$ep sync error" "$BLOCKERS" 2>/dev/null; then
      mkdir -p "$(dirname "$BLOCKERS")"
      touch "$BLOCKERS"
      echo "- **$(date '+%Y-%m-%d')**: $ep sync error — $notes" >> "$BLOCKERS"
    fi
  fi
  _i=$((_i + 1))
done

if $has_errors; then
  log "Some syncs had errors. Check blockers.md."
  tg "⚠️ *$SKYNET_PROJECT_NAME_UPPER SYNC*: Some endpoints had errors. Check blockers.md"
else
  log "All available syncs completed OK."
  tg "🔄 *$SKYNET_PROJECT_NAME_UPPER SYNC*: All endpoints OK"
fi

log "Sync runner finished."
