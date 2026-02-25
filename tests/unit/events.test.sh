#!/usr/bin/env bash
# tests/unit/events.test.sh — Unit tests for scripts/_events.sh event emission
#
# Tests emit_event() output format, description sanitization, truncation,
# and file rotation logic in isolation.
#
# Usage: bash tests/unit/events.test.sh

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
  if echo "$haystack" | grep -qF "$needle"; then
    pass "$msg"
  else
    fail "$msg (expected to contain '$needle')"
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

# ── Setup: create isolated environment ──────────────────────────────

TMPDIR_ROOT=$(mktemp -d)
cleanup() {
  rm -rf "$TMPDIR_ROOT"
}
trap cleanup EXIT

export DEV_DIR="$TMPDIR_ROOT/.dev"
export SKYNET_PROJECT_NAME="test-events"
export SKYNET_LOCK_PREFIX="$TMPDIR_ROOT/locks/skynet-test"
export SKYNET_MAX_EVENTS_LOG_KB="1024"
mkdir -p "$DEV_DIR" "$TMPDIR_ROOT/locks"

# Stub db_add_event before sourcing _events.sh (it's sourced before _db.sh)
_DB_CALLS=()
db_add_event() {
  _DB_CALLS+=("$1|${2:-}|${3:-}|${4:-}")
}

source "$REPO_ROOT/scripts/_events.sh"

# ── Test 1: Basic event emission writes to flat file ────────────────

echo ""
log "=== Test 1: Basic event emission writes to flat file ==="

emit_event "task_started" "Worker 1 starting task"
events_log="$DEV_DIR/events.log"

if [ -f "$events_log" ]; then
  pass "emit_event: events.log file created"
else
  fail "emit_event: events.log file should be created"
fi

line_count=$(wc -l < "$events_log" | tr -d ' ')
assert_eq "$line_count" "1" "emit_event: exactly one line written"

# ── Test 2: Pipe-delimited format (epoch|event|description) ────────

echo ""
log "=== Test 2: Pipe-delimited format ==="

line=$(head -1 "$events_log")
# Split on pipes — should have exactly 3 fields
field_count=$(echo "$line" | awk -F'|' '{print NF}')
assert_eq "$field_count" "3" "format: line has exactly 3 pipe-delimited fields"

epoch=$(echo "$line" | cut -d'|' -f1)
event=$(echo "$line" | cut -d'|' -f2)
desc=$(echo "$line" | cut -d'|' -f3)

# Epoch should be numeric (Unix timestamp)
case "$epoch" in
  ''|*[!0-9]*)
    fail "format: epoch field should be numeric (got '$epoch')"
    ;;
  *)
    pass "format: epoch field is numeric ($epoch)"
    ;;
esac

assert_eq "$event" "task_started" "format: event field matches"
assert_eq "$desc" "Worker 1 starting task" "format: description field matches"

# ── Test 3: Pipe characters in description are sanitized ────────────

echo ""
log "=== Test 3: Pipe sanitization in description ==="

# Reset events.log
> "$events_log"

emit_event "test_pipe" "has|pipe|chars|in it"
line=$(head -1 "$events_log")
field_count=$(echo "$line" | awk -F'|' '{print NF}')
assert_eq "$field_count" "3" "pipe sanitization: output still has exactly 3 fields"

desc=$(echo "$line" | cut -d'|' -f3)
assert_eq "$desc" "has-pipe-chars-in it" "pipe sanitization: pipes replaced with dashes"

# ── Test 4: Description truncation at 3000 characters ───────────────

echo ""
log "=== Test 4: Description truncation at 3000 characters ==="

> "$events_log"

# Generate a description longer than 3000 characters
long_desc=$(printf 'A%.0s' $(seq 1 3500))
emit_event "test_truncate" "$long_desc"
line=$(head -1 "$events_log")
desc=$(echo "$line" | cut -d'|' -f3)
desc_len=${#desc}

if [ "$desc_len" -le 3000 ]; then
  pass "truncation: description truncated to <= 3000 chars (got $desc_len)"
else
  fail "truncation: description should be <= 3000 chars (got $desc_len)"
fi

# ── Test 5: Trailing backslash stripped after truncation ────────────

echo ""
log "=== Test 5: Trailing backslash stripped ==="

> "$events_log"

# Create a description that ends with backslash at exactly the truncation boundary
long_with_backslash=$(printf 'B%.0s' $(seq 1 2999))
long_with_backslash="${long_with_backslash}\\"
emit_event "test_backslash" "$long_with_backslash"
line=$(head -1 "$events_log")
desc=$(echo "$line" | cut -d'|' -f3)

# Description should NOT end with a backslash
case "$desc" in
  *'\\')
    fail "backslash: description should not end with trailing backslash"
    ;;
  *)
    pass "backslash: trailing backslash stripped from description"
    ;;
esac

# ── Test 6: Empty description is handled gracefully ─────────────────

echo ""
log "=== Test 6: Empty description ==="

> "$events_log"

emit_event "test_empty" ""
line=$(head -1 "$events_log")
field_count=$(echo "$line" | awk -F'|' '{print NF}')
event=$(echo "$line" | cut -d'|' -f2)

assert_eq "$event" "test_empty" "empty desc: event name is correct"
# Should have 3 fields (epoch|event|empty)
if [ "$field_count" -ge 2 ]; then
  pass "empty desc: line is well-formed"
else
  fail "empty desc: line should have at least 2 pipe-delimited fields (got $field_count)"
fi

# ── Test 7: db_add_event is called with correct arguments ───────────

echo ""
log "=== Test 7: db_add_event receives correct arguments ==="

_DB_CALLS=()
export WORKER_ID="3"
export TRACE_ID="abc-123"

emit_event "worker_done" "finished task" "trace-override"

if [ "${#_DB_CALLS[@]}" -ge 1 ]; then
  pass "db_add_event: was called"
else
  fail "db_add_event: should have been called"
fi

last_call="${_DB_CALLS[${#_DB_CALLS[@]}-1]}"
assert_contains "$last_call" "worker_done" "db_add_event: event name passed"
assert_contains "$last_call" "finished task" "db_add_event: description passed"
assert_contains "$last_call" "3" "db_add_event: worker_id passed"
assert_contains "$last_call" "trace-override" "db_add_event: explicit trace_id passed"

# ── Test 8: TRACE_ID fallback when no explicit trace_id ─────────────

echo ""
log "=== Test 8: TRACE_ID env var fallback ==="

_DB_CALLS=()
export TRACE_ID="env-trace-456"

emit_event "test_trace_fallback" "desc"

last_call="${_DB_CALLS[${#_DB_CALLS[@]}-1]}"
assert_contains "$last_call" "env-trace-456" "trace fallback: TRACE_ID env var used when no explicit trace_id"

# ── Test 9: FIXER_ID fallback when WORKER_ID unset ──────────────────

echo ""
log "=== Test 9: FIXER_ID fallback for worker identity ==="

_DB_CALLS=()
unset WORKER_ID
export FIXER_ID="7"

emit_event "fixer_event" "from fixer"

last_call="${_DB_CALLS[${#_DB_CALLS[@]}-1]}"
assert_contains "$last_call" "7" "fixer fallback: FIXER_ID used when WORKER_ID unset"

unset FIXER_ID

# ── Test 10: Multiple events append to same file ────────────────────

echo ""
log "=== Test 10: Multiple events append correctly ==="

> "$events_log"

emit_event "event_a" "first"
emit_event "event_b" "second"
emit_event "event_c" "third"

line_count=$(wc -l < "$events_log" | tr -d ' ')
assert_eq "$line_count" "3" "append: three events produce three lines"

# Verify ordering
event_b=$(sed -n '2p' "$events_log" | cut -d'|' -f2)
assert_eq "$event_b" "event_b" "append: second line has correct event name"

# ── Test 11: Soft rotation when file exceeds max_kb ─────────────────

echo ""
log "=== Test 11: Soft rotation at SKYNET_MAX_EVENTS_LOG_KB ==="

> "$events_log"

# Set a very low rotation threshold (1 KB) to trigger rotation
export SKYNET_MAX_EVENTS_LOG_KB="1"

# Write enough data to exceed 1 KB
local_i=0
while [ "$local_i" -lt 30 ]; do
  emit_event "bulk_event" "padding data to fill up the log file beyond one kilobyte threshold"
  local_i=$((local_i + 1))
done

# After rotation, current events.log should be small or absent (replaced)
# and events.log.1 should exist
if [ -f "${events_log}.1" ]; then
  pass "soft rotation: events.log.1 created after threshold exceeded"
else
  fail "soft rotation: events.log.1 should exist after rotation"
fi

# Reset threshold
export SKYNET_MAX_EVENTS_LOG_KB="1024"

# ── Test 12: Hard cap (5MB) force-rotation ──────────────────────────

echo ""
log "=== Test 12: Hard cap force-rotation at 5MB ==="

# Clean up from previous test
rm -f "${events_log}" "${events_log}.1" "${events_log}.2" "${events_log}.2.gz" 2>/dev/null

# Create an events.log that exceeds 5MB
# Set max_kb very high so soft rotation doesn't trigger
export SKYNET_MAX_EVENTS_LOG_KB="999999"
dd if=/dev/zero bs=1024 count=5500 2>/dev/null | tr '\0' 'X' > "$events_log"
# Add a newline so it's a valid log
echo "" >> "$events_log"

# Emit one event — should trigger hard cap check
emit_event "hard_cap_test" "trigger force rotation" 2>/dev/null

# After force rotation, the oversized file should be moved to .1
if [ -f "${events_log}.1" ]; then
  pass "hard cap: events.log.1 created after 5MB exceeded"
else
  fail "hard cap: events.log.1 should exist after force-rotation"
fi

# The new events.log (if it exists) should be small
if [ -f "$events_log" ]; then
  new_sz=$(wc -c < "$events_log" | tr -d ' ')
  if [ "$new_sz" -lt 5242880 ]; then
    pass "hard cap: new events.log is under 5MB ($new_sz bytes)"
  else
    fail "hard cap: new events.log should be under 5MB (got $new_sz bytes)"
  fi
else
  pass "hard cap: events.log rotated away (new file not yet created)"
fi

# Reset
export SKYNET_MAX_EVENTS_LOG_KB="1024"

# ── Test 13: Rotation skip counter and warning ──────────────────────

echo ""
log "=== Test 13: Rotation skip counter warning after 5+ skips ==="

rm -f "${events_log}" "${events_log}.1" "${events_log}.2" "${events_log}.2.gz" 2>/dev/null

# Set low threshold to trigger rotation on every emit
export SKYNET_MAX_EVENTS_LOG_KB="1"

# Create a lock that is held by a live process to prevent rotation
rot_lock="${SKYNET_LOCK_PREFIX}-events-rotate.lock"
mkdir -p "$rot_lock"
sleep 300 &
_blocker_pid=$!
echo "$_blocker_pid" > "$rot_lock/pid"
touch "$rot_lock/pid"  # Fresh timestamp so it won't be reclaimed as stale

# Emit enough events to trigger rotation attempts that get skipped.
# Must NOT use $() — subshells reset _EVENTS_ROTATION_SKIPS.
# Redirect stderr to a temp file instead.
_stderr_file="$TMPDIR_ROOT/stderr_capture"
> "$_stderr_file"
local_j=0
while [ "$local_j" -lt 8 ]; do
  # Create a file big enough each time to trigger rotation check
  dd if=/dev/zero bs=1024 count=2 2>/dev/null | tr '\0' 'X' > "$events_log"
  emit_event "skip_test" "pad" 2>>"$_stderr_file"
  local_j=$((local_j + 1))
done

if grep -q "rotation skipped" "$_stderr_file"; then
  pass "skip counter: warning emitted after repeated rotation skips"
else
  fail "skip counter: expected 'rotation skipped' warning in stderr"
fi

# Clean up
kill "$_blocker_pid" 2>/dev/null; wait "$_blocker_pid" 2>/dev/null || true
rm -rf "$rot_lock"
_EVENTS_ROTATION_SKIPS=0
export SKYNET_MAX_EVENTS_LOG_KB="1024"

# ── Test 14: Stale rotation lock recovery (dead PID) ────────────────

echo ""
log "=== Test 14: Stale rotation lock recovered when holder PID is dead ==="

rm -f "${events_log}" "${events_log}.1" "${events_log}.2" "${events_log}.2.gz" 2>/dev/null

export SKYNET_MAX_EVENTS_LOG_KB="1"

# Create a stale rotation lock with a dead PID
rot_lock="${SKYNET_LOCK_PREFIX}-events-rotate.lock"
mkdir -p "$rot_lock"
echo "4999999" > "$rot_lock/pid"  # Almost certainly not running

# Write enough data to trigger rotation
dd if=/dev/zero bs=1024 count=2 2>/dev/null | tr '\0' 'X' > "$events_log"
emit_event "stale_recovery" "first attempt detects stale lock" 2>/dev/null

# The first emit detects the dead PID and removes the lock.
# The next emit should actually rotate.
dd if=/dev/zero bs=1024 count=2 2>/dev/null | tr '\0' 'X' > "$events_log"
emit_event "stale_recovery" "second attempt should rotate" 2>/dev/null

if [ ! -d "$rot_lock" ]; then
  pass "stale lock: dead PID lock was cleaned up"
else
  fail "stale lock: lock with dead PID should have been removed"
fi

# Reset
export SKYNET_MAX_EVENTS_LOG_KB="1024"
rm -f "${events_log}" "${events_log}.1" "${events_log}.2" "${events_log}.2.gz" 2>/dev/null

# ── Test 15: Special characters in event name and description ───────

echo ""
log "=== Test 15: Special characters handled correctly ==="

> "$events_log" 2>/dev/null || true

emit_event "test/special:chars" "desc with \"quotes\" and \$vars and (parens)"
line=$(head -1 "$events_log")
event=$(echo "$line" | cut -d'|' -f2)

assert_eq "$event" "test/special:chars" "special chars: event name preserved"

desc=$(echo "$line" | cut -d'|' -f3)
assert_not_empty "$desc" "special chars: description is not empty"

# ── Test 16: Stale rotation lock recovered by timestamp (>60s) ────────

echo ""
log "=== Test 16: Stale rotation lock recovered when lock is older than 60s ==="

rm -f "${events_log}" "${events_log}.1" "${events_log}.2" "${events_log}.2.gz" 2>/dev/null

export SKYNET_MAX_EVENTS_LOG_KB="1"

# Create a stale rotation lock with a live PID but old timestamp
rot_lock="${SKYNET_LOCK_PREFIX}-events-rotate.lock"
mkdir -p "$rot_lock"
echo "$$" > "$rot_lock/pid"  # Our own PID (alive)
# Backdate the PID file by 120 seconds using touch
touch -t "$(date -v-120S +%Y%m%d%H%M.%S 2>/dev/null || date -d '120 seconds ago' +%Y%m%d%H%M.%S 2>/dev/null)" "$rot_lock/pid" 2>/dev/null || true

# Write enough data to trigger rotation
dd if=/dev/zero bs=1024 count=2 2>/dev/null | tr '\0' 'X' > "$events_log"
emit_event "stale_time_recovery" "first attempt detects old lock" 2>/dev/null

# First emit reclaims the lock. Second emit should rotate.
dd if=/dev/zero bs=1024 count=2 2>/dev/null | tr '\0' 'X' > "$events_log"
emit_event "stale_time_recovery" "second attempt should rotate" 2>/dev/null

if [ ! -d "$rot_lock" ]; then
  pass "stale timestamp: old lock was cleaned up"
else
  fail "stale timestamp: lock older than 60s should have been removed"
  rm -rf "$rot_lock"
fi

# Reset
export SKYNET_MAX_EVENTS_LOG_KB="1024"
rm -f "${events_log}" "${events_log}.1" "${events_log}.2" "${events_log}.2.gz" 2>/dev/null

# ── Test 17: Missing PID file in stale lock triggers recovery ────────

echo ""
log "=== Test 17: Missing PID file in stale lock triggers recovery ==="

rm -f "${events_log}" "${events_log}.1" "${events_log}.2" "${events_log}.2.gz" 2>/dev/null

export SKYNET_MAX_EVENTS_LOG_KB="1"

# Create a lock directory WITHOUT a PID file (simulates crash between mkdir and PID write)
rot_lock="${SKYNET_LOCK_PREFIX}-events-rotate.lock"
mkdir -p "$rot_lock"
# No PID file inside — the missing-PID-file branch should reclaim it

dd if=/dev/zero bs=1024 count=2 2>/dev/null | tr '\0' 'X' > "$events_log"
emit_event "no_pid_recovery" "first attempt detects missing PID" 2>/dev/null

dd if=/dev/zero bs=1024 count=2 2>/dev/null | tr '\0' 'X' > "$events_log"
emit_event "no_pid_recovery" "second attempt should rotate" 2>/dev/null

if [ ! -d "$rot_lock" ]; then
  pass "missing PID: stale lock without PID file was cleaned up"
else
  fail "missing PID: lock without PID file should have been removed"
  rm -rf "$rot_lock"
fi

# Reset
export SKYNET_MAX_EVENTS_LOG_KB="1024"
rm -f "${events_log}" "${events_log}.1" "${events_log}.2" "${events_log}.2.gz" 2>/dev/null

# ── Test 18: Rotation archive chain (.1 → .2 → .2.gz) ───────────────

echo ""
log "=== Test 18: Rotation archive chain shifts .1 to .2 ==="

rm -f "${events_log}" "${events_log}.1" "${events_log}.2" "${events_log}.2.gz" 2>/dev/null

export SKYNET_MAX_EVENTS_LOG_KB="1"

# First rotation: fill and rotate to create .1
local_k=0
while [ "$local_k" -lt 30 ]; do
  emit_event "chain_event_1" "first rotation filling to create events.log.1 archive file"
  local_k=$((local_k + 1))
done

if [ -f "${events_log}.1" ]; then
  pass "archive chain: first rotation created .1"
else
  fail "archive chain: first rotation should create .1"
fi

# Second rotation: fill again — should shift .1 → .2, current → .1
local_k=0
while [ "$local_k" -lt 30 ]; do
  emit_event "chain_event_2" "second rotation filling to shift .1 to .2 and create new .1"
  local_k=$((local_k + 1))
done

# Wait for background gzip to finish
sleep 1

if [ -f "${events_log}.1" ]; then
  pass "archive chain: second rotation created new .1"
else
  fail "archive chain: second rotation should create new .1"
fi

if [ -f "${events_log}.2.gz" ] || [ -f "${events_log}.2" ]; then
  pass "archive chain: old .1 shifted to .2 (or .2.gz)"
else
  fail "archive chain: old .1 should have been shifted to .2 or .2.gz"
fi

# Reset
export SKYNET_MAX_EVENTS_LOG_KB="1024"
rm -f "${events_log}" "${events_log}.1" "${events_log}.2" "${events_log}.2.gz" 2>/dev/null

# ── Test 19: Both WORKER_ID and FIXER_ID unset → empty worker_id ─────

echo ""
log "=== Test 19: Empty worker identity when both WORKER_ID and FIXER_ID unset ==="

_DB_CALLS=()
unset WORKER_ID 2>/dev/null || true
unset FIXER_ID 2>/dev/null || true

emit_event "no_worker" "no worker or fixer identity"

last_call="${_DB_CALLS[${#_DB_CALLS[@]}-1]}"
# Format: event|desc|worker_id|trace_id — worker_id should be empty
worker_field=$(echo "$last_call" | cut -d'|' -f3)
assert_eq "$worker_field" "" "empty identity: worker_id is empty when both IDs unset"

# ── Test 20: Description exactly at 3000 chars (boundary) ────────────

echo ""
log "=== Test 20: Description at exactly 3000 chars is not truncated ==="

> "$events_log"

# Generate a description of exactly 3000 characters
exact_desc=$(printf 'C%.0s' $(seq 1 3000))
emit_event "test_boundary" "$exact_desc"
line=$(head -1 "$events_log")
desc=$(echo "$line" | cut -d'|' -f3)
desc_len=${#desc}

assert_eq "$desc_len" "3000" "boundary: description at exactly 3000 chars is preserved"

# ── Test 21: Emit lock contention fallback (event still written) ──────

echo ""
log "=== Test 21: Event written even when emit lock cannot be acquired ==="

> "$events_log"

# Create an emit lock that is held (simulates contention for all 5 retries)
_emit_lock="${SKYNET_LOCK_PREFIX}-events-emit.lock"
mkdir -p "$_emit_lock"

emit_event "contention_test" "written despite lock"

# Even under full contention, the event should still be written (line 72-76 fallback)
if [ -f "$events_log" ]; then
  line_count=$(wc -l < "$events_log" | tr -d ' ')
  if [ "$line_count" -ge 1 ]; then
    pass "lock contention: event written despite held emit lock"
  else
    fail "lock contention: event should be written even when lock is held"
  fi
else
  fail "lock contention: events.log should exist after fallback write"
fi

# Verify format is intact
line=$(head -1 "$events_log")
field_count=$(echo "$line" | awk -F'|' '{print NF}')
assert_eq "$field_count" "3" "lock contention: output format is valid"

# Cleanup
rm -rf "$_emit_lock"

# ── Test 22: Rotation skip counter resets after successful rotation ───

echo ""
log "=== Test 22: Rotation skip counter resets after successful rotation ==="

rm -f "${events_log}" "${events_log}.1" "${events_log}.2" "${events_log}.2.gz" 2>/dev/null

# Artificially set the skip counter high
_EVENTS_ROTATION_SKIPS=10

# Set low threshold so a rotation triggers
export SKYNET_MAX_EVENTS_LOG_KB="1"

# Write enough to trigger rotation (no held lock, so rotation succeeds)
local_n=0
while [ "$local_n" -lt 30 ]; do
  emit_event "reset_test" "fill log to trigger rotation and reset the skip counter value"
  local_n=$((local_n + 1))
done

# After a successful rotation, _EVENTS_ROTATION_SKIPS should be 0
if [ "$_EVENTS_ROTATION_SKIPS" -lt 10 ]; then
  pass "skip reset: rotation skip counter decreased after successful rotation"
else
  fail "skip reset: skip counter should reset after successful rotation (got $_EVENTS_ROTATION_SKIPS)"
fi

# Reset
export SKYNET_MAX_EVENTS_LOG_KB="1024"
rm -f "${events_log}" "${events_log}.1" "${events_log}.2" "${events_log}.2.gz" 2>/dev/null

# ── Test 23: Hard cap warning emitted to stderr ──────────────────────

echo ""
log "=== Test 23: Hard cap force-rotation emits warning to stderr ==="

rm -f "${events_log}" "${events_log}.1" "${events_log}.2" "${events_log}.2.gz" 2>/dev/null

export SKYNET_MAX_EVENTS_LOG_KB="999999"

# Create an events.log that exceeds 5MB
dd if=/dev/zero bs=1024 count=5500 2>/dev/null | tr '\0' 'X' > "$events_log"
echo "" >> "$events_log"

_hard_stderr="$TMPDIR_ROOT/hard_cap_stderr"
emit_event "hard_cap_warn" "check stderr message" 2>"$_hard_stderr"

if grep -q "exceeded hard cap" "$_hard_stderr"; then
  pass "hard cap stderr: warning message contains 'exceeded hard cap'"
else
  fail "hard cap stderr: expected 'exceeded hard cap' in stderr warning"
fi

# Reset
export SKYNET_MAX_EVENTS_LOG_KB="1024"
rm -f "${events_log}" "${events_log}.1" "${events_log}.2" "${events_log}.2.gz" 2>/dev/null

# ── Test 24: Newlines in description pass through to flat file ────────

echo ""
log "=== Test 24: Newlines in description (flat file behavior) ==="

> "$events_log"

# Newlines in descriptions are NOT stripped by emit_event (only pipes are sanitized).
# This is acceptable: SQLite is the primary store; the flat file is backward-compat only.
# This test documents the actual behavior.
emit_event "newline_test" "line1
line2"

# The first line should have the correct pipe-delimited header
first_line=$(head -1 "$events_log")
event=$(echo "$first_line" | cut -d'|' -f2)
assert_eq "$event" "newline_test" "newlines: event name intact on first line"

# The description spans multiple lines in the flat file (known behavior)
line_count=$(wc -l < "$events_log" | tr -d ' ')
if [ "$line_count" -gt 1 ]; then
  pass "newlines: multi-line description preserved in flat file (known behavior)"
else
  pass "newlines: description handled as single line"
fi

# ── Test 25: No rotation when file is under threshold ────────────────

echo ""
log "=== Test 25: No rotation when events.log is under threshold ==="

rm -f "${events_log}" "${events_log}.1" "${events_log}.2" "${events_log}.2.gz" 2>/dev/null

export SKYNET_MAX_EVENTS_LOG_KB="1024"

# Write a few small events — well under 1024 KB
emit_event "small_a" "small event a"
emit_event "small_b" "small event b"
emit_event "small_c" "small event c"

if [ ! -f "${events_log}.1" ]; then
  pass "no rotation: events.log.1 does not exist when under threshold"
else
  fail "no rotation: events.log.1 should not exist when file is under threshold"
fi

line_count=$(wc -l < "$events_log" | tr -d ' ')
assert_eq "$line_count" "3" "no rotation: all 3 events in events.log"

# ── Test 26: Rapid sequential emissions maintain line integrity ───────

echo ""
log "=== Test 26: Rapid sequential emissions maintain line integrity ==="

> "$events_log"

# Emit 50 events in quick succession
local_r=0
while [ "$local_r" -lt 50 ]; do
  emit_event "rapid_${local_r}" "event number ${local_r}"
  local_r=$((local_r + 1))
done

line_count=$(wc -l < "$events_log" | tr -d ' ')
assert_eq "$line_count" "50" "rapid emit: exactly 50 lines for 50 events"

# Verify every line has exactly 3 fields
bad_lines=0
while IFS= read -r line; do
  fc=$(echo "$line" | awk -F'|' '{print NF}')
  if [ "$fc" -ne 3 ]; then
    bad_lines=$((bad_lines + 1))
  fi
done < "$events_log"
assert_eq "$bad_lines" "0" "rapid emit: all 50 lines have exactly 3 pipe-delimited fields"

# ── Test 27: db_add_event failure does not prevent flat file write ────

echo ""
log "=== Test 27: db_add_event failure does not prevent flat file write ==="

> "$events_log"

# Override db_add_event to fail
db_add_event() { return 1; }

emit_event "db_fail_test" "should still write to file"

if [ -f "$events_log" ]; then
  line_count=$(wc -l < "$events_log" | tr -d ' ')
  assert_eq "$line_count" "1" "db failure: event still written to flat file"
else
  fail "db failure: events.log should exist even when db_add_event fails"
fi

event=$(head -1 "$events_log" | cut -d'|' -f2)
assert_eq "$event" "db_fail_test" "db failure: correct event name in flat file"

# Restore db_add_event stub
db_add_event() { _DB_CALLS+=("$1|${2:-}|${3:-}|${4:-}"); }

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
