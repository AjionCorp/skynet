#!/usr/bin/env bash
# tests/unit/config.test.sh — Unit tests for scripts/_config.sh shared infrastructure helpers
#
# Tests: _json_escape, _log (text & JSON), _generate_trace_id, rotate_log_if_needed,
#        _get_active_mission_slug, _get_worker_mission_slug, _resolve_active_mission,
#        _validate_config_numerics (clamping), validate_backlog
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

# ── Setup: create isolated environment ──────────────────────────────

TMPDIR_ROOT=$(mktemp -d)
cleanup() { rm -rf "$TMPDIR_ROOT"; }
trap cleanup EXIT

# Create minimal config for sourcing _config.sh
export SKYNET_DEV_DIR="$TMPDIR_ROOT/dev"
mkdir -p "$SKYNET_DEV_DIR/missions"
cat > "$SKYNET_DEV_DIR/skynet.config.sh" << CONF
export SKYNET_PROJECT_NAME="test-config"
export SKYNET_PROJECT_DIR="$TMPDIR_ROOT/project"
export SKYNET_DEV_DIR="$SKYNET_DEV_DIR"
CONF
mkdir -p "$TMPDIR_ROOT/project"

# Source _config.sh (suppressing warnings from validators/notify)
cd "$REPO_ROOT"
source scripts/_config.sh 2>/dev/null || true

echo "config.test.sh — unit tests for _config.sh shared infrastructure helpers"

# ── _json_escape ────────────────────────────────────────────────────

echo ""
log "=== _json_escape ==="

# Test 1: double quotes
result=$(_json_escape 'hello"world')
assert_eq "$result" 'hello\"world' "_json_escape: double quotes"

# Test 2: backslashes
result=$(_json_escape 'a\b')
assert_eq "$result" 'a\\b' "_json_escape: backslash"

# Test 3: newlines
result=$(_json_escape "$(printf 'line1\nline2')")
assert_eq "$result" 'line1\nline2' "_json_escape: newlines"

# Test 4: tabs
result=$(_json_escape "$(printf 'col1\tcol2')")
assert_eq "$result" 'col1\tcol2' "_json_escape: tabs"

# Test 5: carriage returns
result=$(_json_escape "$(printf 'line1\rline2')")
assert_eq "$result" 'line1\rline2' "_json_escape: carriage returns"

# Test 6: empty string
result=$(_json_escape '')
assert_eq "$result" '' "_json_escape: empty string"

# Test 7: forward slashes NOT escaped (RFC 8259)
result=$(_json_escape 'path/to/file')
assert_eq "$result" 'path/to/file' "_json_escape: forward slashes preserved"

# Test 8: combined special chars
result=$(_json_escape "$(printf 'a"b\\c\nd')")
assert_eq "$result" 'a\"b\\c\nd' "_json_escape: combined special chars"

# ── _log text format ────────────────────────────────────────────────

echo ""
log "=== _log (text format) ==="

export SKYNET_LOG_FORMAT="text"
unset TRACE_ID 2>/dev/null || true

# Test 9: includes label and message
result=$(_log "info" "W1" "test message")
if echo "$result" | grep -qF '[W1] test message'; then
  pass "_log text: includes label and message"
else
  fail "_log text: includes label and message (got '$result')"
fi

# Test 10: empty label omits brackets
result=$(_log "info" "" "no label msg")
if echo "$result" | grep -qF 'no label msg' && ! echo "$result" | grep -qF '[]'; then
  pass "_log text: empty label omits brackets"
else
  fail "_log text: empty label omits brackets (got '$result')"
fi

# Test 11: writes to file
_log_testfile="$TMPDIR_ROOT/test-log.txt"
_log "warn" "T1" "file log test" "$_log_testfile"
if [ -f "$_log_testfile" ] && grep -qF 'file log test' "$_log_testfile"; then
  pass "_log text: writes to file"
else
  fail "_log text: writes to file"
fi
rm -f "$_log_testfile"

# Test 12: timestamp format
result=$(_log "info" "W1" "ts test")
if echo "$result" | grep -qE '^\[[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}\]'; then
  pass "_log text: timestamp has YYYY-MM-DD HH:MM:SS format"
else
  fail "_log text: timestamp has YYYY-MM-DD HH:MM:SS format (got '$result')"
fi

# Test 13: appends to existing file
_log_testfile="$TMPDIR_ROOT/append-log.txt"
echo "existing line" > "$_log_testfile"
_log "info" "T2" "appended line" "$_log_testfile"
_line_count=$(wc -l < "$_log_testfile" | tr -d ' ')
if [ "$_line_count" = "2" ]; then
  pass "_log text: appends to existing file"
else
  fail "_log text: appends to existing file (expected 2 lines, got $_line_count)"
fi
rm -f "$_log_testfile"

# ── _log JSON format ────────────────────────────────────────────────

echo ""
log "=== _log (JSON format) ==="

export SKYNET_LOG_FORMAT="json"
unset TRACE_ID 2>/dev/null || true

# Test 14: basic JSON structure with level, worker, msg
result=$(_log "info" "W2" "json test")
if echo "$result" | grep -qF '"level":"info"' \
   && echo "$result" | grep -qF '"worker":"W2"' \
   && echo "$result" | grep -qF '"msg":"json test"'; then
  pass "_log JSON: includes level, worker, msg fields"
else
  fail "_log JSON: includes level, worker, msg fields (got '$result')"
fi

# Test 15: ISO 8601 UTC timestamp
if echo "$result" | grep -qE '"ts":"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z"'; then
  pass "_log JSON: ISO 8601 UTC timestamp"
else
  fail "_log JSON: ISO 8601 UTC timestamp (got '$result')"
fi

# Test 16: includes trace_id when TRACE_ID set
export TRACE_ID="abc123def456"
result=$(_log "warn" "W3" "traced msg")
if echo "$result" | grep -qF '"trace_id":"abc123def456"'; then
  pass "_log JSON: includes trace_id when TRACE_ID set"
else
  fail "_log JSON: includes trace_id when TRACE_ID set (got '$result')"
fi
unset TRACE_ID

# Test 17: omits trace_id when TRACE_ID unset
unset TRACE_ID 2>/dev/null || true
result=$(_log "info" "W4" "no trace")
if echo "$result" | grep -qF 'trace_id'; then
  fail "_log JSON: omits trace_id when TRACE_ID unset"
else
  pass "_log JSON: omits trace_id when TRACE_ID unset"
fi

# Test 18: escapes special chars in message
result=$(_log "info" "W5" 'msg with "quotes"')
if echo "$result" | grep -qF '\"quotes\"'; then
  pass "_log JSON: escapes quotes in message"
else
  fail "_log JSON: escapes quotes in message (got '$result')"
fi

# Reset log format
export SKYNET_LOG_FORMAT="text"

# ── _generate_trace_id ──────────────────────────────────────────────

echo ""
log "=== _generate_trace_id ==="

# Test 19: returns non-empty string
trace=$(_generate_trace_id)
if [ -n "$trace" ]; then
  pass "_generate_trace_id: returns non-empty string"
else
  fail "_generate_trace_id: returns non-empty string"
fi

# Test 20: reasonable length (12 hex chars or PID-epoch fallback)
trace_len=${#trace}
if [ "$trace_len" -ge 3 ] && [ "$trace_len" -le 20 ]; then
  pass "_generate_trace_id: reasonable length ($trace_len chars)"
else
  fail "_generate_trace_id: reasonable length (got $trace_len chars)"
fi

# Test 21: successive calls produce different IDs
trace1=$(_generate_trace_id)
trace2=$(_generate_trace_id)
if [ "$trace1" != "$trace2" ]; then
  pass "_generate_trace_id: successive calls produce different IDs"
else
  fail "_generate_trace_id: successive calls produce different IDs (both='$trace1')"
fi

# ── rotate_log_if_needed ────────────────────────────────────────────

echo ""
log "=== rotate_log_if_needed ==="

_rot_dir="$TMPDIR_ROOT/rotation"
mkdir -p "$_rot_dir"

# Test 22: no rotation when file is small
_rot_small="$_rot_dir/small.log"
echo "small" > "$_rot_small"
export SKYNET_MAX_LOG_SIZE_KB=1
rotate_log_if_needed "$_rot_small"
if [ -f "$_rot_small" ] && [ ! -f "${_rot_small}.1" ]; then
  pass "rotate_log_if_needed: no rotation when under limit"
else
  fail "rotate_log_if_needed: no rotation when under limit"
fi

# Test 23: rotation when file exceeds limit
_rot_big="$_rot_dir/big.log"
dd if=/dev/zero bs=1100 count=1 2>/dev/null | tr '\0' 'x' > "$_rot_big"
rotate_log_if_needed "$_rot_big"
if [ ! -f "$_rot_big" ] && [ -f "${_rot_big}.1" ]; then
  pass "rotate_log_if_needed: rotates file exceeding limit"
else
  fail "rotate_log_if_needed: rotates file exceeding limit (orig=$([ -f "$_rot_big" ] && echo exists || echo gone), .1=$([ -f "${_rot_big}.1" ] && echo exists || echo missing))"
fi

# Test 24: second rotation shifts .1 to .2
_rot_multi="$_rot_dir/multi.log"
echo "old content" > "${_rot_multi}.1"
dd if=/dev/zero bs=1100 count=1 2>/dev/null | tr '\0' 'y' > "$_rot_multi"
rotate_log_if_needed "$_rot_multi"
sleep 0.2  # give background gzip a moment
if [ -f "${_rot_multi}.1" ] && { [ -f "${_rot_multi}.2" ] || [ -f "${_rot_multi}.2.gz" ]; }; then
  pass "rotate_log_if_needed: shifts .1 to .2 on second rotation"
else
  fail "rotate_log_if_needed: shifts .1 to .2 on second rotation"
fi

# Test 25: no-op for nonexistent file
rotate_log_if_needed "$_rot_dir/nonexistent.log"
pass "rotate_log_if_needed: no-op for nonexistent file (no error)"

# ── _get_active_mission_slug ────────────────────────────────────────

echo ""
log "=== _get_active_mission_slug ==="

# Test 26: returns slug from valid config
cat > "$MISSION_CONFIG" << 'MJSON'
{
  "activeMission": "alpha-feature",
  "assignments": {}
}
MJSON
echo "# Alpha Feature" > "$MISSIONS_DIR/alpha-feature.md"

result=$(_get_active_mission_slug)
assert_eq "$result" "alpha-feature" "_get_active_mission_slug: returns slug from valid config"

# Test 27: returns empty when config file missing
_saved_config="$MISSION_CONFIG"
mv "$MISSION_CONFIG" "${MISSION_CONFIG}.bak"
result=$(_get_active_mission_slug)
assert_eq "$result" "" "_get_active_mission_slug: returns empty when config missing"
mv "${MISSION_CONFIG}.bak" "$MISSION_CONFIG"

# Test 28: returns empty when mission .md file doesn't exist
cat > "$MISSION_CONFIG" << 'MJSON'
{
  "activeMission": "nonexistent-mission",
  "assignments": {}
}
MJSON
result=$(_get_active_mission_slug)
assert_eq "$result" "" "_get_active_mission_slug: returns empty when mission file missing"

# Test 29: returns empty when activeMission is empty string
cat > "$MISSION_CONFIG" << 'MJSON'
{
  "activeMission": "",
  "assignments": {}
}
MJSON
result=$(_get_active_mission_slug)
assert_eq "$result" "" "_get_active_mission_slug: returns empty for empty activeMission"

# ── _get_worker_mission_slug ────────────────────────────────────────

echo ""
log "=== _get_worker_mission_slug ==="

# Test 30: returns assigned worker slug
cat > "$MISSION_CONFIG" << 'MJSON'
{
  "activeMission": "alpha-feature",
  "assignments": {
    "w1": "beta-bugfix",
    "w2": "alpha-feature"
  }
}
MJSON
echo "# Beta Bugfix" > "$MISSIONS_DIR/beta-bugfix.md"

result=$(_get_worker_mission_slug "w1")
assert_eq "$result" "beta-bugfix" "_get_worker_mission_slug: returns assigned slug"

# Test 31: falls back to active mission when worker unassigned
result=$(_get_worker_mission_slug "w3")
assert_eq "$result" "alpha-feature" "_get_worker_mission_slug: falls back to active mission"

# Test 32: returns empty when config missing
mv "$MISSION_CONFIG" "${MISSION_CONFIG}.bak"
result=$(_get_worker_mission_slug "w1")
assert_eq "$result" "" "_get_worker_mission_slug: returns empty when config missing"
mv "${MISSION_CONFIG}.bak" "$MISSION_CONFIG"

# ── _resolve_active_mission ─────────────────────────────────────────

echo ""
log "=== _resolve_active_mission ==="

# Test 33: returns mission file path when active
cat > "$MISSION_CONFIG" << 'MJSON'
{
  "activeMission": "alpha-feature",
  "assignments": {}
}
MJSON

result=$(_resolve_active_mission)
assert_eq "$result" "$MISSIONS_DIR/alpha-feature.md" "_resolve_active_mission: returns active mission file"

# Test 34: falls back to legacy mission.md when no active mission
cat > "$MISSION_CONFIG" << 'MJSON'
{
  "activeMission": "",
  "assignments": {}
}
MJSON
result=$(_resolve_active_mission)
assert_eq "$result" "$MISSION" "_resolve_active_mission: falls back to legacy mission.md"

# Test 35: falls back when mission file doesn't exist
cat > "$MISSION_CONFIG" << 'MJSON'
{
  "activeMission": "ghost-mission",
  "assignments": {}
}
MJSON
result=$(_resolve_active_mission)
assert_eq "$result" "$MISSION" "_resolve_active_mission: falls back when mission file missing"

# ── _validate_config_numerics (clamping) ────────────────────────────

echo ""
log "=== _validate_config_numerics (clamping) ==="

# Test 36: clamps value below minimum
# NOTE: >/dev/null 2>&1 suppresses _clamp's warnings (which go to stdout via
# the test's inherited log() function) so only our echo is captured.
clamped=$(
  export SKYNET_DEV_DIR="$TMPDIR_ROOT/dev"
  export SKYNET_STALE_MINUTES=1  # min is 5
  cd "$REPO_ROOT"
  source scripts/_config.sh >/dev/null 2>&1 || true
  echo "$SKYNET_STALE_MINUTES"
)
assert_eq "$clamped" "5" "_clamp: value below min (1) clamped to min (5)"

# Test 37: clamps value above maximum
clamped=$(
  export SKYNET_DEV_DIR="$TMPDIR_ROOT/dev"
  export SKYNET_MAX_WORKERS=99  # max is 16
  cd "$REPO_ROOT"
  source scripts/_config.sh >/dev/null 2>&1 || true
  echo "$SKYNET_MAX_WORKERS"
)
assert_eq "$clamped" "16" "_clamp: value above max (99) clamped to max (16)"

# Test 38: value in range stays unchanged
clamped=$(
  export SKYNET_DEV_DIR="$TMPDIR_ROOT/dev"
  export SKYNET_STALE_MINUTES=60
  cd "$REPO_ROOT"
  source scripts/_config.sh >/dev/null 2>&1 || true
  echo "$SKYNET_STALE_MINUTES"
)
assert_eq "$clamped" "60" "_clamp: value in range (60) stays unchanged"

# Test 39: non-numeric value is skipped (not clamped)
clamped=$(
  export SKYNET_DEV_DIR="$TMPDIR_ROOT/dev"
  export SKYNET_STALE_MINUTES="abc"
  cd "$REPO_ROOT"
  source scripts/_config.sh >/dev/null 2>&1 || true
  echo "$SKYNET_STALE_MINUTES"
)
assert_eq "$clamped" "abc" "_clamp: non-numeric value is skipped"

# ── validate_backlog ────────────────────────────────────────────────

echo ""
log "=== validate_backlog ==="

# Test 40: returns 0 when DB file doesn't exist
_orig_db="${DB_PATH:-}"
export DB_PATH="$TMPDIR_ROOT/nonexistent.db"
validate_backlog; _vb_rc=$?
assert_eq "$_vb_rc" "0" "validate_backlog: returns 0 when DB missing"
export DB_PATH="$_orig_db"

# ── Summary ─────────────────────────────────────────────────────────

echo ""
TOTAL=$((PASS + FAIL))
log "Results: $PASS/$TOTAL passed, $FAIL failed"
if [ "$FAIL" -eq 0 ]; then
  printf "  \033[32mAll checks passed!\033[0m\n"
else
  printf "  \033[31mSome checks failed!\033[0m\n"
  exit 1
fi
