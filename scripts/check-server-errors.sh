#!/usr/bin/env bash
# check-server-errors.sh — Scan dev server log for runtime errors
# Writes actionable errors to blockers.md
# Usage: bash scripts/check-server-errors.sh [minutes_to_check]
# Returns: 0 if no errors, 1 if errors found

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_config.sh"

SERVER_LOG="$SCRIPTS_DIR/next-dev.log"
LOG="$SCRIPTS_DIR/server-errors.log"
MINUTES="${1:-5}"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

if [ ! -f "$SERVER_LOG" ]; then
  log "No server log found at $SERVER_LOG. Dev server may not be using log capture."
  exit 0
fi

# Get recent log lines (last N minutes based on file modification)
# Use the last 200 lines as a proxy for recent activity
recent=$(tail -200 "$SERVER_LOG")

# --- Pattern matching for common server errors ---
errors_found=0
error_messages=""

# Check configured env var keys for missing values in logs
IFS=' ' read -ra _env_keys <<< "${SKYNET_ERROR_ENV_KEYS:-}"
for key in "${_env_keys[@]}"; do
  [ -z "$key" ] && continue
  if echo "$recent" | grep -qi "$key.*missing\|$key.*undefined\|$key.*not set\|$key.*required\|Cannot read.*$key\|env.*$key" 2>/dev/null; then
    errors_found=1
    error_messages="$error_messages\n- Missing env var: $key"
    log "FOUND: Missing $key"
  fi
done

# Generic env var missing patterns
env_errors=$(echo "$recent" | grep -i "environment variable.*required\|env.*not found\|api.key.*missing\|api.key.*invalid\|api_key.*undefined" 2>/dev/null | head -5 || true)
if [ -n "$env_errors" ]; then
  errors_found=1
  while IFS= read -r line; do
    error_messages="$error_messages\n- $line"
  done <<< "$env_errors"
fi

# Database connection errors
if echo "$recent" | grep -qi "ECONNREFUSED.*5432\|supabase.*connection\|postgres.*error\|relation.*does not exist\|permission denied.*table" 2>/dev/null; then
  errors_found=1
  db_error=$(echo "$recent" | grep -i "ECONNREFUSED\|supabase.*error\|postgres.*error\|relation.*does not exist" | tail -1)
  error_messages="$error_messages\n- Database error: $db_error"
  log "FOUND: Database error"
fi

# Auth / token errors
if echo "$recent" | grep -qi "invalid.*token\|jwt.*expired\|unauthorized.*service.role\|auth.*error.*supabase" 2>/dev/null; then
  errors_found=1
  auth_error=$(echo "$recent" | grep -i "invalid.*token\|jwt.*expired\|unauthorized\|auth.*error" | tail -1)
  error_messages="$error_messages\n- Auth error: $auth_error"
  log "FOUND: Auth error"
fi

# Rate limiting
if echo "$recent" | grep -qi "rate.limit\|429\|too many requests\|quota.*exceeded" 2>/dev/null; then
  errors_found=1
  error_messages="$error_messages\n- API rate limit hit (check server log for details)"
  log "FOUND: Rate limit error"
fi

# Unhandled server errors (500s)
error_500=$(echo "$recent" | grep -c "500\|Internal Server Error\|INTERNAL_SERVER_ERROR" 2>/dev/null || echo "0")
if [ "$error_500" -gt 2 ]; then
  errors_found=1
  error_messages="$error_messages\n- Multiple 500 errors detected ($error_500 occurrences in recent logs)"
  log "FOUND: $error_500 server 500 errors"
fi

# --- Write to blockers if errors found ---
if [ "$errors_found" -eq 1 ]; then
  log "Server errors detected. Updating blockers.md."

  # Only add if not already reported today
  today=$(date '+%Y-%m-%d')
  if ! grep -q "$today.*Server runtime errors" "$BLOCKERS" 2>/dev/null; then
    printf "\n- **%s**: Server runtime errors detected:\n%b\n  Check full log: %s/next-dev.log" "$today" "$error_messages" "$SCRIPTS_DIR" >> "$BLOCKERS"
  fi

  log "Errors written to blockers.md"
  exit 1
else
  log "No server errors detected."
  exit 0
fi
