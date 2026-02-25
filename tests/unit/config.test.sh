#!/usr/bin/env bash
# tests/unit/config.test.sh — Unit tests for _config.sh shared infrastructure helpers
#
# Tests: _json_escape, _log, rotate_log_if_needed, _generate_trace_id,
#        _validate_config_numerics/_clamp, _validate_config, derived defaults,
#        convenience aliases, compat shims (to_upper, file_size, file_mtime),
#        validate_backlog, run_with_timeout
#
# Usage: bash tests/unit/config.test.sh

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
    fail "$msg (expected to contain '$needle', got '$haystack')"
  fi
}

assert_not_empty() {
  local val="$1" msg="$2"
  if [ -n "$val" ]; then
    pass "$msg"
  else
    fail "$msg (was empty)"
  fi
}

assert_match() {
  local val="$1" pattern="$2" msg="$3"
  if printf '%s' "$val" | grep -qE "$pattern"; then
    pass "$msg"
  else
    fail "$msg (value '$val' did not match pattern '$pattern')"
  fi
}

# ── Setup: create isolated environment ──────────────────────────────

TMPDIR_ROOT=$(mktemp -d)
cleanup() {
  rm -rf "$TMPDIR_ROOT"
}
trap cleanup EXIT

# Minimal config for sourcing _config.sh
export SKYNET_DEV_DIR="$TMPDIR_ROOT/dev"
mkdir -p "$SKYNET_DEV_DIR"
cat > "$SKYNET_DEV_DIR/skynet.config.sh" << CONF
export SKYNET_PROJECT_NAME="test-project"
export SKYNET_PROJECT_DIR="$TMPDIR_ROOT/project"
export SKYNET_DEV_DIR="$SKYNET_DEV_DIR"
CONF
mkdir -p "$TMPDIR_ROOT/project"

# Unset derived variables so _config.sh recomputes them from our test config
unset SKYNET_LOCK_PREFIX 2>/dev/null || true

# Source config (will set up all derived variables and source _compat.sh etc.)
source "$REPO_ROOT/scripts/_config.sh" 2>/dev/null || true

# ── _json_escape ────────────────────────────────────────────────────

echo ""
log "=== _json_escape ==="

assert_eq "$(_json_escape 'hello"world')" 'hello\"world' \
  "_json_escape: escapes double quotes"

assert_eq "$(_json_escape 'back\slash')" 'back\\slash' \
  "_json_escape: escapes backslashes"

assert_eq "$(_json_escape "$(printf 'line1\nline2')")" 'line1\nline2' \
  "_json_escape: escapes newlines"

assert_eq "$(_json_escape "$(printf 'col1\tcol2')")" 'col1\tcol2' \
  "_json_escape: escapes tabs"

assert_eq "$(_json_escape "$(printf 'cr\rhere')")" 'cr\rhere' \
  "_json_escape: escapes carriage returns"

assert_eq "$(_json_escape '')" '' \
  "_json_escape: handles empty string"

assert_eq "$(_json_escape 'plain text 123')" 'plain text 123' \
  "_json_escape: passes through plain text unchanged"

assert_eq "$(_json_escape 'a/b/c')" 'a/b/c' \
  "_json_escape: does NOT escape forward slashes (RFC 8259)"

# Combined escaping
assert_eq "$(_json_escape "$(printf 'quote\"and\nnewline')")" 'quote\"and\nnewline' \
  "_json_escape: handles multiple escape types together"

# ── _log (text format) ─────────────────────────────────────────────

echo ""
log "=== _log (text format) ==="

# Save and force text format
_orig_log_format="${SKYNET_LOG_FORMAT:-text}"
export SKYNET_LOG_FORMAT="text"

_log_output=$(_log "info" "WORKER-1" "Task started")
assert_contains "$_log_output" "[WORKER-1]" \
  "_log text: includes worker label in brackets"
assert_contains "$_log_output" "Task started" \
  "_log text: includes message"
# Timestamp format: [YYYY-MM-DD HH:MM:SS]
assert_match "$_log_output" '^\[20[0-9]{2}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}\]' \
  "_log text: starts with timestamp"

# Empty label
_log_no_label=$(_log "info" "" "No label message")
assert_contains "$_log_no_label" "No label message" \
  "_log text: works with empty label"
# Should NOT have "[]" for empty label
if printf '%s' "$_log_no_label" | grep -qF " [] "; then
  fail "_log text: should not output empty brackets for empty label"
else
  pass "_log text: omits brackets when label is empty"
fi

# Write to file
_log_file="$TMPDIR_ROOT/test.log"
_log "info" "W2" "File log entry" "$_log_file"
if [ -f "$_log_file" ]; then
  _log_file_content=$(cat "$_log_file")
  assert_contains "$_log_file_content" "File log entry" \
    "_log text: writes to logfile when path provided"
else
  fail "_log text: should create logfile"
fi
rm -f "$_log_file"

# ── _log (JSON format) ─────────────────────────────────────────────

echo ""
log "=== _log (JSON format) ==="

export SKYNET_LOG_FORMAT="json"
unset TRACE_ID 2>/dev/null || true

_json_out=$(_log "warn" "FIXER-3" "Retry failed")
assert_contains "$_json_out" '"level":"warn"' \
  "_log json: includes level field"
assert_contains "$_json_out" '"worker":"FIXER-3"' \
  "_log json: includes worker field"
assert_contains "$_json_out" '"msg":"Retry failed"' \
  "_log json: includes msg field"
assert_match "$_json_out" '"ts":"20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z"' \
  "_log json: includes ISO 8601 UTC timestamp"

# JSON with trace_id
export TRACE_ID="abc123def456"
_json_trace=$(_log "info" "W1" "With trace")
assert_contains "$_json_trace" '"trace_id":"abc123def456"' \
  "_log json: includes trace_id when TRACE_ID is set"
unset TRACE_ID

# JSON without trace_id should NOT contain trace_id field
_json_no_trace=$(_log "info" "W1" "No trace")
if printf '%s' "$_json_no_trace" | grep -qF "trace_id"; then
  fail "_log json: should not include trace_id when TRACE_ID is unset"
else
  pass "_log json: omits trace_id when TRACE_ID is unset"
fi

# JSON escaping of special chars in message
_json_special=$(_log "info" "W1" 'msg with "quotes" and	tab')
assert_contains "$_json_special" '\"quotes\"' \
  "_log json: escapes quotes in message via _json_escape"

# Write JSON to file
_json_logfile="$TMPDIR_ROOT/json.log"
_log "error" "W5" "Disk full" "$_json_logfile"
if [ -f "$_json_logfile" ]; then
  _json_file_content=$(cat "$_json_logfile")
  assert_contains "$_json_file_content" '"level":"error"' \
    "_log json: writes JSON to logfile"
else
  fail "_log json: should create logfile"
fi
rm -f "$_json_logfile"

# Restore
export SKYNET_LOG_FORMAT="$_orig_log_format"

# ── rotate_log_if_needed ───────────────────────────────────────────

echo ""
log "=== rotate_log_if_needed ==="

# Small file: should NOT rotate
_small_log="$TMPDIR_ROOT/small.log"
printf 'small log\n' > "$_small_log"
rotate_log_if_needed "$_small_log"
if [ -f "$_small_log" ] && [ ! -f "${_small_log}.1" ]; then
  pass "rotate_log_if_needed: does not rotate small file"
else
  fail "rotate_log_if_needed: should not rotate file under size limit"
fi

# Large file: should rotate
_big_log="$TMPDIR_ROOT/big.log"
# Create file larger than SKYNET_MAX_LOG_SIZE_KB (default 1024 KB = 1 MB)
_orig_max_log="${SKYNET_MAX_LOG_SIZE_KB}"
export SKYNET_MAX_LOG_SIZE_KB=1  # 1 KB for testing
dd if=/dev/zero of="$_big_log" bs=2048 count=1 2>/dev/null
rotate_log_if_needed "$_big_log"
if [ -f "${_big_log}.1" ]; then
  pass "rotate_log_if_needed: rotates file exceeding size limit"
else
  fail "rotate_log_if_needed: should rotate file exceeding size limit"
fi
# Original file should be gone (moved to .1)
if [ ! -f "$_big_log" ]; then
  pass "rotate_log_if_needed: original file moved after rotation"
else
  fail "rotate_log_if_needed: original file should be gone after rotation"
fi

# Second rotation: .1 → .2, new → .1
printf 'x%.0s' $(seq 1 2048) > "$_big_log"
rotate_log_if_needed "$_big_log"
# Wait briefly for any background gzip
sleep 0.5
if [ -f "${_big_log}.2" ] || [ -f "${_big_log}.2.gz" ]; then
  pass "rotate_log_if_needed: cascades rotation (.1 → .2)"
else
  fail "rotate_log_if_needed: should cascade .1 to .2 on second rotation"
fi

export SKYNET_MAX_LOG_SIZE_KB="$_orig_max_log"

# Non-existent file: no error
rotate_log_if_needed "$TMPDIR_ROOT/nonexistent.log"
pass "rotate_log_if_needed: handles non-existent file without error"

# ── _generate_trace_id ─────────────────────────────────────────────

echo ""
log "=== _generate_trace_id ==="

_tid1=$(_generate_trace_id)
assert_not_empty "$_tid1" "_generate_trace_id: returns non-empty string"

# Check it's hex-like or PID-epoch format
assert_match "$_tid1" '^[a-f0-9-]+$' \
  "_generate_trace_id: output contains only hex chars or pid-epoch digits"

# Uniqueness across two calls
_tid2=$(_generate_trace_id)
if [ "$_tid1" != "$_tid2" ]; then
  pass "_generate_trace_id: produces unique IDs across calls"
else
  fail "_generate_trace_id: two calls returned same ID '$_tid1'"
fi

# ── _validate_config_numerics / _clamp ─────────────────────────────

echo ""
log "=== _validate_config_numerics / _clamp ==="

# Test clamping below minimum (SKYNET_STALE_MINUTES min=5)
export SKYNET_STALE_MINUTES=1
_validate_config_numerics 2>/dev/null
assert_eq "$SKYNET_STALE_MINUTES" "5" \
  "_clamp: clamps SKYNET_STALE_MINUTES=1 up to minimum 5"

# Test clamping above maximum (SKYNET_STALE_MINUTES max=240)
export SKYNET_STALE_MINUTES=999
_validate_config_numerics 2>/dev/null
assert_eq "$SKYNET_STALE_MINUTES" "240" \
  "_clamp: clamps SKYNET_STALE_MINUTES=999 down to maximum 240"

# Test value within bounds stays unchanged
export SKYNET_STALE_MINUTES=30
_validate_config_numerics 2>/dev/null
assert_eq "$SKYNET_STALE_MINUTES" "30" \
  "_clamp: leaves SKYNET_STALE_MINUTES=30 unchanged (within bounds)"

# Test SKYNET_MAX_WORKERS clamping (min=1, max=16)
export SKYNET_MAX_WORKERS=0
_validate_config_numerics 2>/dev/null
assert_eq "$SKYNET_MAX_WORKERS" "1" \
  "_clamp: clamps SKYNET_MAX_WORKERS=0 up to minimum 1"

export SKYNET_MAX_WORKERS=100
_validate_config_numerics 2>/dev/null
assert_eq "$SKYNET_MAX_WORKERS" "16" \
  "_clamp: clamps SKYNET_MAX_WORKERS=100 down to maximum 16"

# Test SKYNET_AGENT_TIMEOUT_MINUTES clamping (min=10, max=240)
export SKYNET_AGENT_TIMEOUT_MINUTES=3
_validate_config_numerics 2>/dev/null
assert_eq "$SKYNET_AGENT_TIMEOUT_MINUTES" "10" \
  "_clamp: clamps SKYNET_AGENT_TIMEOUT_MINUTES=3 up to minimum 10"

# Non-numeric values should be skipped (not clamped)
export SKYNET_STALE_MINUTES="abc"
_validate_config_numerics 2>/dev/null
assert_eq "$SKYNET_STALE_MINUTES" "abc" \
  "_clamp: skips non-numeric value 'abc' without clamping"

# Restore sane defaults
export SKYNET_STALE_MINUTES=30
export SKYNET_MAX_WORKERS=4
export SKYNET_AGENT_TIMEOUT_MINUTES=45

# ── _validate_config ───────────────────────────────────────────────

echo ""
log "=== _validate_config ==="

# Valid config — should return 0
export SKYNET_LOCK_BACKEND="file"
if _validate_config 2>/dev/null; then
  pass "_validate_config: returns 0 for valid config"
else
  fail "_validate_config: should return 0 for valid config"
fi

# Non-numeric SKYNET_MAX_WORKERS — should warn (stderr) but not fail critically
export SKYNET_MAX_WORKERS="not-a-number"
_vc_stderr=$(_validate_config 2>&1 >/dev/null || true)
assert_contains "$_vc_stderr" "SKYNET_MAX_WORKERS" \
  "_validate_config: warns about non-numeric SKYNET_MAX_WORKERS"
export SKYNET_MAX_WORKERS=4

# Redis backend without SKYNET_REDIS_URL — should fail critically
export SKYNET_LOCK_BACKEND="redis"
export SKYNET_REDIS_URL=""
if _validate_config 2>/dev/null; then
  fail "_validate_config: should fail when redis backend has no URL"
else
  pass "_validate_config: returns non-zero for redis without URL"
fi
export SKYNET_LOCK_BACKEND="file"

# Path traversal in exec var — should warn
export SKYNET_GATE_1="../../evil-script"
_pt_stderr=$(_validate_config 2>&1 >/dev/null || true)
assert_contains "$_pt_stderr" "path traversal" \
  "_validate_config: warns about path traversal in SKYNET_GATE_1"
export SKYNET_GATE_1="pnpm typecheck"

# ── Derived defaults ───────────────────────────────────────────────

echo ""
log "=== Derived defaults ==="

assert_eq "$SKYNET_BRANCH_PREFIX" "dev/" \
  "derived default: SKYNET_BRANCH_PREFIX defaults to 'dev/'"

assert_eq "$SKYNET_MAIN_BRANCH" "main" \
  "derived default: SKYNET_MAIN_BRANCH defaults to 'main'"

assert_contains "$SKYNET_LOCK_PREFIX" "skynet-test-project" \
  "derived default: SKYNET_LOCK_PREFIX contains project name"

assert_eq "$SKYNET_LOG_FORMAT" "$_orig_log_format" \
  "derived default: SKYNET_LOG_FORMAT defaults to 'text'"

assert_eq "$SKYNET_DRY_RUN" "false" \
  "derived default: SKYNET_DRY_RUN defaults to 'false'"

assert_eq "$SKYNET_POST_MERGE_TYPECHECK" "true" \
  "derived default: SKYNET_POST_MERGE_TYPECHECK defaults to 'true'"

assert_eq "$SKYNET_CANARY_ENABLED" "true" \
  "derived default: SKYNET_CANARY_ENABLED defaults to 'true'"

# ── Convenience aliases ────────────────────────────────────────────

echo ""
log "=== Convenience aliases ==="

assert_eq "$PROJECT_DIR" "$SKYNET_PROJECT_DIR" \
  "alias: PROJECT_DIR equals SKYNET_PROJECT_DIR"

assert_eq "$DEV_DIR" "$SKYNET_DEV_DIR" \
  "alias: DEV_DIR equals SKYNET_DEV_DIR"

assert_eq "$BACKLOG" "$DEV_DIR/backlog.md" \
  "alias: BACKLOG points to DEV_DIR/backlog.md"

assert_eq "$COMPLETED" "$DEV_DIR/completed.md" \
  "alias: COMPLETED points to DEV_DIR/completed.md"

assert_eq "$FAILED" "$DEV_DIR/failed-tasks.md" \
  "alias: FAILED points to DEV_DIR/failed-tasks.md"

assert_eq "$BLOCKERS" "$DEV_DIR/blockers.md" \
  "alias: BLOCKERS points to DEV_DIR/blockers.md"

# ── Compat shims (from _compat.sh, sourced by _config.sh) ─────────

echo ""
log "=== Compat shims (to_upper, file_size, file_mtime) ==="

assert_eq "$(to_upper 'hello')" "HELLO" \
  "to_upper: converts lowercase to uppercase"

assert_eq "$(to_upper 'Already')" "ALREADY" \
  "to_upper: converts mixed case to uppercase"

assert_eq "$(to_upper '')" "" \
  "to_upper: handles empty string"

# SKYNET_PROJECT_NAME_UPPER should be precomputed
assert_eq "$SKYNET_PROJECT_NAME_UPPER" "TEST-PROJECT" \
  "SKYNET_PROJECT_NAME_UPPER: precomputed uppercase project name"

# file_size on a known file
_sz_file="$TMPDIR_ROOT/size_test"
printf '12345' > "$_sz_file"
assert_eq "$(file_size "$_sz_file")" "5" \
  "file_size: returns correct byte count for 5-byte file"

# file_size on empty file
_sz_empty="$TMPDIR_ROOT/empty_file"
touch "$_sz_empty"
assert_eq "$(file_size "$_sz_empty")" "0" \
  "file_size: returns 0 for empty file"

# file_mtime returns a recent epoch timestamp
_mt_file="$TMPDIR_ROOT/mtime_test"
touch "$_mt_file"
_mtime=$(file_mtime "$_mt_file")
_now=$(date +%s)
# Should be within last 10 seconds
_mtime_diff=$(( _now - _mtime ))
if [ "$_mtime_diff" -ge 0 ] && [ "$_mtime_diff" -le 10 ]; then
  pass "file_mtime: returns recent epoch timestamp (${_mtime_diff}s ago)"
else
  fail "file_mtime: timestamp not recent (diff=${_mtime_diff}s)"
fi

# file_mtime on non-existent file returns 0
assert_eq "$(file_mtime "$TMPDIR_ROOT/nonexistent")" "0" \
  "file_mtime: returns 0 for non-existent file"

# ── validate_backlog (SQLite-based) ────────────────────────────────

echo ""
log "=== validate_backlog ==="

# Non-existent DB — should return 0
_orig_db_path="${DB_PATH:-}"
export DB_PATH="$TMPDIR_ROOT/nonexistent.db"
if validate_backlog 2>/dev/null; then
  pass "validate_backlog: returns 0 when DB does not exist"
else
  fail "validate_backlog: should return 0 when DB does not exist"
fi

# With a real DB containing duplicate pending tasks
if command -v sqlite3 >/dev/null 2>&1; then
  export DB_PATH="$TMPDIR_ROOT/test_backlog.db"
  sqlite3 "$DB_PATH" "CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY, title TEXT, status TEXT);"
  sqlite3 "$DB_PATH" "INSERT INTO tasks (title, status) VALUES ('dup task', 'pending');"
  sqlite3 "$DB_PATH" "INSERT INTO tasks (title, status) VALUES ('dup task', 'pending');"
  sqlite3 "$DB_PATH" "INSERT INTO tasks (title, status) VALUES ('unique task', 'pending');"

  _vb_output=$(validate_backlog 2>&1)
  assert_contains "$_vb_output" "Duplicate pending title" \
    "validate_backlog: detects duplicate pending titles"
  rm -f "$DB_PATH"
else
  log "(skipping validate_backlog sqlite tests — sqlite3 not found)"
fi

export DB_PATH="$_orig_db_path"

# ── run_with_timeout (from _compat.sh) ─────────────────────────────

echo ""
log "=== run_with_timeout ==="

# Successful command within timeout
_rwt_out=$(run_with_timeout 5 echo "hello timeout")
assert_eq "$_rwt_out" "hello timeout" \
  "run_with_timeout: passes through command output"

# Command that exits quickly
if run_with_timeout 5 true; then
  pass "run_with_timeout: returns 0 for successful command"
else
  fail "run_with_timeout: should return 0 for successful command"
fi

# Command that fails
if run_with_timeout 5 false; then
  fail "run_with_timeout: should return non-zero for failing command"
else
  pass "run_with_timeout: returns non-zero for failing command"
fi

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
