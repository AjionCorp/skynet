#!/usr/bin/env bash
# tests/unit/check-server-errors.test.sh — Unit tests for scripts/check-server-errors.sh
#
# Tests: missing log file, clean log, env var errors (custom + generic),
# database errors, auth errors, rate limiting, 500 threshold, blocker
# deduplication, and multiple error types.
#
# Usage: bash tests/unit/check-server-errors.test.sh

# NOTE: -e is intentionally omitted — the test uses its own PASS/FAIL counters
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PASS=0
FAIL=0

log()  { printf "  %s\n" "$*"; }
pass() { PASS=$((PASS + 1)); printf "  \033[32m✓\033[0m %s\n" "$*"; }
fail() { FAIL=$((FAIL + 1)); printf "  \033[31m✗\033[0m %s\n" "$*"; }

assert_eq() {
  local actual="$1" expected="$2" msg="$3"
  if [ "$actual" = "$expected" ]; then
    pass "$msg"
  else
    fail "$msg (expected '$expected', got '$actual')"
  fi
}

assert_contains() {
  local haystack="$1" needle="$2" msg="$3"
  if printf '%s' "$haystack" | grep -qF "$needle"; then
    pass "$msg"
  else
    fail "$msg (expected to contain '$needle')"
  fi
}

assert_not_contains() {
  local haystack="$1" needle="$2" msg="$3"
  if printf '%s' "$haystack" | grep -qF "$needle"; then
    fail "$msg (should NOT contain '$needle')"
  else
    pass "$msg"
  fi
}

# ── Setup: create isolated environment ──────────────────────────────

TMPDIR_ROOT=$(mktemp -d)
cleanup() {
  rm -rf "$TMPDIR_ROOT"
}
trap cleanup EXIT

MOCK_SCRIPTS_DIR="$TMPDIR_ROOT/scripts"
MOCK_DEV_DIR="$TMPDIR_ROOT/.dev"
mkdir -p "$MOCK_SCRIPTS_DIR" "$MOCK_DEV_DIR"

MOCK_BLOCKERS="$MOCK_DEV_DIR/blockers.md"

# Create a minimal _config.sh stub.
# check-server-errors.sh sources _config.sh relative to its own location,
# so we place the stub alongside our copy of the script.
cat > "$MOCK_SCRIPTS_DIR/_config.sh" << STUB
# Stub _config.sh — provides only what check-server-errors.sh needs
SCRIPTS_DIR="\$(cd "\$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
BLOCKERS="$MOCK_BLOCKERS"
# SKYNET_ERROR_ENV_KEYS passed via environment
STUB

# Copy the script under test into the mock scripts dir
cp "$REPO_ROOT/scripts/check-server-errors.sh" "$MOCK_SCRIPTS_DIR/check-server-errors.sh"

# Helper: run check-server-errors.sh and capture exit code + blockers content
# Arguments:
#   $1 — path to the server log file to check
#   $2 — SKYNET_ERROR_ENV_KEYS value (optional, default "")
# Sets: _rc (exit code), _output (stdout+stderr), _blockers (blockers.md content)
run_check() {
  local log_path="${1:-}"
  local env_keys="${2:-}"
  local run_log="$TMPDIR_ROOT/run.log"
  rm -f "$run_log"

  _rc=0
  (
    export SKYNET_ERROR_ENV_KEYS="$env_keys"
    bash "$MOCK_SCRIPTS_DIR/check-server-errors.sh" "$log_path" >> "$run_log" 2>&1
  ) || _rc=$?

  _output=""
  [ -f "$run_log" ] && _output=$(cat "$run_log")
  _blockers=""
  [ -f "$MOCK_BLOCKERS" ] && _blockers=$(cat "$MOCK_BLOCKERS")
}

echo "check-server-errors.test.sh — unit tests for scripts/check-server-errors.sh"

# ── Test: missing log file exits 0 ──────────────────────────────────

echo ""
log "=== MISSING_LOG: no server log file ==="

: > "$MOCK_BLOCKERS"
run_check "$TMPDIR_ROOT/nonexistent.log" ""
assert_eq "$_rc" "0" "missing log: exit code 0"
assert_contains "$_output" "No server log found" "missing log: message logged"
assert_eq "$_blockers" "" "missing log: no blocker written"

# ── Test: clean log with no error patterns ───────────────────────────

echo ""
log "=== CLEAN_LOG: no error patterns ==="

SERVER_LOG="$TMPDIR_ROOT/clean.log"
cat > "$SERVER_LOG" << 'LOG'
[2026-03-03 10:00:00] GET /api/health 200 OK
[2026-03-03 10:00:01] GET /api/status 200 OK
[2026-03-03 10:00:02] POST /api/tasks 201 Created
[2026-03-03 10:00:03] Normal operation, all systems go
LOG

: > "$MOCK_BLOCKERS"
run_check "$SERVER_LOG" ""
assert_eq "$_rc" "0" "clean log: exit code 0"
assert_contains "$_output" "No server errors detected" "clean log: reports clean"
assert_eq "$_blockers" "" "clean log: no blocker written"

# ── Test: custom env key errors (SKYNET_ERROR_ENV_KEYS) ──────────────

echo ""
log "=== CUSTOM_ENV_KEYS: SKYNET_ERROR_ENV_KEYS detection ==="

SERVER_LOG="$TMPDIR_ROOT/env-key.log"
cat > "$SERVER_LOG" << 'LOG'
[2026-03-03 10:00:00] Error: SUPABASE_URL missing from environment
[2026-03-03 10:00:01] Cannot read SUPABASE_URL
LOG

: > "$MOCK_BLOCKERS"
run_check "$SERVER_LOG" "SUPABASE_URL"
assert_eq "$_rc" "1" "custom env key: exit code 1"
assert_contains "$_output" "Missing SUPABASE_URL" "custom env key: log mentions key"
assert_contains "$_blockers" "Server runtime errors" "custom env key: blocker written"

# ── Test: generic env var missing patterns ───────────────────────────

echo ""
log "=== GENERIC_ENV: generic environment variable errors ==="

SERVER_LOG="$TMPDIR_ROOT/generic-env.log"
cat > "$SERVER_LOG" << 'LOG'
[2026-03-03 10:00:00] Error: environment variable API_SECRET required
[2026-03-03 10:00:01] api key missing for service X
LOG

: > "$MOCK_BLOCKERS"
run_check "$SERVER_LOG" ""
assert_eq "$_rc" "1" "generic env: exit code 1"
assert_contains "$_blockers" "Server runtime errors" "generic env: blocker written"

# ── Test: database connection errors ─────────────────────────────────

echo ""
log "=== DB_ERROR: database connection errors ==="

SERVER_LOG="$TMPDIR_ROOT/db-error.log"
cat > "$SERVER_LOG" << 'LOG'
[2026-03-03 10:00:00] Error: connect ECONNREFUSED 127.0.0.1:5432
[2026-03-03 10:00:01] relation "users" does not exist
LOG

: > "$MOCK_BLOCKERS"
run_check "$SERVER_LOG" ""
assert_eq "$_rc" "1" "db error: exit code 1"
assert_contains "$_output" "Database error" "db error: log mentions database"
assert_contains "$_blockers" "Database error" "db error: blocker has database error"

# ── Test: auth/token errors ──────────────────────────────────────────

echo ""
log "=== AUTH_ERROR: auth and token errors ==="

SERVER_LOG="$TMPDIR_ROOT/auth-error.log"
cat > "$SERVER_LOG" << 'LOG'
[2026-03-03 10:00:00] Error: invalid auth token provided
[2026-03-03 10:00:01] jwt expired at 2026-03-03T09:00:00Z
LOG

: > "$MOCK_BLOCKERS"
run_check "$SERVER_LOG" ""
assert_eq "$_rc" "1" "auth error: exit code 1"
assert_contains "$_output" "Auth error" "auth error: log mentions auth"
assert_contains "$_blockers" "Auth error" "auth error: blocker has auth error"

# ── Test: rate limiting ──────────────────────────────────────────────

echo ""
log "=== RATE_LIMIT: rate limiting errors ==="

SERVER_LOG="$TMPDIR_ROOT/rate-limit.log"
cat > "$SERVER_LOG" << 'LOG'
[2026-03-03 10:00:00] HTTP 429 Too Many Requests
[2026-03-03 10:00:01] rate limit exceeded for /api/completions
LOG

: > "$MOCK_BLOCKERS"
run_check "$SERVER_LOG" ""
assert_eq "$_rc" "1" "rate limit: exit code 1"
assert_contains "$_output" "Rate limit" "rate limit: log mentions rate limit"
assert_contains "$_blockers" "rate limit" "rate limit: blocker has rate limit"

# ── Test: 500 errors above threshold (>2) ────────────────────────────

echo ""
log "=== 500_ABOVE: 500 errors above threshold ==="

SERVER_LOG="$TMPDIR_ROOT/500-above.log"
cat > "$SERVER_LOG" << 'LOG'
[2026-03-03 10:00:00] GET /api/tasks 500 Internal Server Error
[2026-03-03 10:00:01] GET /api/status 500 Internal Server Error
[2026-03-03 10:00:02] POST /api/deploy 500 Internal Server Error
LOG

: > "$MOCK_BLOCKERS"
run_check "$SERVER_LOG" ""
assert_eq "$_rc" "1" "500 above: exit code 1"
assert_contains "$_output" "500 errors" "500 above: log mentions 500 errors"
assert_contains "$_blockers" "500 errors" "500 above: blocker has 500 errors"

# ── Test: 500 errors at threshold (<=2) — no alert ──────────────────

echo ""
log "=== 500_BELOW: 500 errors at/below threshold ==="

SERVER_LOG="$TMPDIR_ROOT/500-below.log"
cat > "$SERVER_LOG" << 'LOG'
[2026-03-03 10:00:00] GET /api/tasks 500 Internal Server Error
[2026-03-03 10:00:01] GET /api/status 500 Internal Server Error
LOG

: > "$MOCK_BLOCKERS"
run_check "$SERVER_LOG" ""
assert_eq "$_rc" "0" "500 below: exit code 0 (at threshold)"
assert_contains "$_output" "No server errors detected" "500 below: reports clean"
assert_eq "$_blockers" "" "500 below: no blocker written"

# ── Test: blocker deduplication ──────────────────────────────────────

echo ""
log "=== BLOCKER_DEDUP: not duplicated when already reported today ==="

SERVER_LOG="$TMPDIR_ROOT/dedup.log"
cat > "$SERVER_LOG" << 'LOG'
[2026-03-03 10:00:00] Error: connect ECONNREFUSED 127.0.0.1:5432
LOG

today=$(date '+%Y-%m-%d')
printf "\n- **%s**: Server runtime errors detected:\n- Database error: old entry\n" "$today" > "$MOCK_BLOCKERS"

run_check "$SERVER_LOG" ""
assert_eq "$_rc" "1" "blocker dedup: exit code 1 (errors still found)"
blocker_count=$(grep -c "Server runtime errors" "$MOCK_BLOCKERS" || true)
assert_eq "$blocker_count" "1" "blocker dedup: not duplicated"

# ── Test: multiple error types in one log ────────────────────────────

echo ""
log "=== MULTI_ERROR: multiple error types detected ==="

SERVER_LOG="$TMPDIR_ROOT/multi-error.log"
cat > "$SERVER_LOG" << 'LOG'
[2026-03-03 10:00:00] Error: connect ECONNREFUSED 127.0.0.1:5432
[2026-03-03 10:00:01] Error: invalid auth token provided
[2026-03-03 10:00:02] HTTP 429 Too Many Requests
[2026-03-03 10:00:03] GET /api/x 500 Internal Server Error
[2026-03-03 10:00:04] GET /api/y 500 Internal Server Error
[2026-03-03 10:00:05] GET /api/z 500 Internal Server Error
LOG

: > "$MOCK_BLOCKERS"
run_check "$SERVER_LOG" ""
assert_eq "$_rc" "1" "multi error: exit code 1"
assert_contains "$_blockers" "Database error" "multi error: database error in blockers"
assert_contains "$_blockers" "Auth error" "multi error: auth error in blockers"
assert_contains "$_blockers" "rate limit" "multi error: rate limit in blockers"
assert_contains "$_blockers" "500 errors" "multi error: 500 errors in blockers"

# ── Test: custom env key — no match exits 0 ──────────────────────────

echo ""
log "=== CUSTOM_ENV_NOMATCH: env key present but no match in log ==="

SERVER_LOG="$TMPDIR_ROOT/env-nomatch.log"
cat > "$SERVER_LOG" << 'LOG'
[2026-03-03 10:00:00] GET /api/health 200 OK
[2026-03-03 10:00:01] Normal operation
LOG

: > "$MOCK_BLOCKERS"
run_check "$SERVER_LOG" "SUPABASE_URL OPENAI_KEY"
assert_eq "$_rc" "0" "env key no match: exit code 0"
assert_eq "$_blockers" "" "env key no match: no blocker written"

# ── Summary ──────────────────────────────────────────────────────────

echo ""
TOTAL=$((PASS + FAIL))
log "Results: $PASS/$TOTAL passed, $FAIL failed"
if [ "$FAIL" -eq 0 ]; then
  printf "  \033[32mAll checks passed!\033[0m\n"
else
  printf "  \033[31mSome checks failed!\033[0m\n"
  exit 1
fi
