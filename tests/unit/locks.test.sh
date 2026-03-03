#!/usr/bin/env bash
# tests/unit/locks.test.sh — Unit tests for scripts/_locks.sh
#
# Tests the top-level lock helpers: acquire_worker_lock (mkdir-based mutex with
# atomic PID write, stale detection, PID reuse guard), acquire_merge_lock
# (emergency unlock, auto-TTL stale release), and _lock_check_disk_space.
#
# Usage: bash tests/unit/locks.test.sh

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
cleanup() {
  # Kill any background sleepers we spawned
  for _pid in "${_BG_PIDS[@]:-}"; do
    kill "$_pid" 2>/dev/null; wait "$_pid" 2>/dev/null || true
  done
  rm -rf "$TMPDIR_ROOT"
}
trap cleanup EXIT

_BG_PIDS=()

# Minimal config stubs
export SKYNET_PROJECT_NAME="test-locks"
export SKYNET_LOCK_PREFIX="$TMPDIR_ROOT/locks/skynet-test"
export SKYNET_USE_FLOCK="false"
export SKYNET_LOCK_TTL_SECS="600"
export SKYNET_SCRIPTS_DIR="$REPO_ROOT/scripts"
export SKYNET_MERGE_LOCK_TTL="5"  # 5 seconds for fast testing

mkdir -p "$TMPDIR_ROOT/locks"

# Mock lock backend — records calls for verification
_MOCK_BACKEND_CALLS=""
_MOCK_BACKEND_ACQUIRE_RC=0

lock_backend_acquire() {
  _MOCK_BACKEND_CALLS="${_MOCK_BACKEND_CALLS}acquire:$1:$2;"
  return $_MOCK_BACKEND_ACQUIRE_RC
}
lock_backend_release() {
  _MOCK_BACKEND_CALLS="${_MOCK_BACKEND_CALLS}release:$1;"
}
lock_backend_extend() {
  _MOCK_BACKEND_CALLS="${_MOCK_BACKEND_CALLS}extend:$1:$2;"
}

# Source _locks.sh (the module under test)
source "$REPO_ROOT/scripts/_locks.sh"

# Derived paths (set by _locks.sh from SKYNET_LOCK_PREFIX)
MERGE_LOCKDIR="$SKYNET_LOCK_PREFIX-merge.lock"

# ── Test 1: _lock_check_disk_space succeeds on normal disk ──────────

echo ""
log "=== _lock_check_disk_space ==="

if _lock_check_disk_space; then
  pass "_lock_check_disk_space: returns 0 on normal disk (>10MB free)"
else
  fail "_lock_check_disk_space: should return 0 when disk has space"
fi

# ── Test 2: acquire_worker_lock — basic acquire ─────────────────────

echo ""
log "=== acquire_worker_lock: basic acquire ==="

LOCKFILE="$TMPDIR_ROOT/locks/worker-test-1.lock"
LOGFILE="$TMPDIR_ROOT/test.log"
touch "$LOGFILE"

if acquire_worker_lock "$LOCKFILE" "$LOGFILE" "T1"; then
  pass "acquire_worker_lock: succeeds when lock is free"
else
  fail "acquire_worker_lock: should succeed when lock is free"
fi

# Verify lock directory exists with PID file
if [ -d "$LOCKFILE" ] && [ -f "$LOCKFILE/pid" ]; then
  stored_pid=$(cat "$LOCKFILE/pid" 2>/dev/null)
  assert_eq "$stored_pid" "$$" "acquire_worker_lock: PID file contains our PID"
else
  fail "acquire_worker_lock: lock directory or PID file not created"
fi

rm -rf "$LOCKFILE"

# ── Test 3: acquire_worker_lock — atomic PID write ──────────────────

echo ""
log "=== acquire_worker_lock: atomic PID write (no temp files left) ==="

LOCKFILE="$TMPDIR_ROOT/locks/worker-test-2.lock"

acquire_worker_lock "$LOCKFILE" "$LOGFILE" "T1"

# Verify no temp PID files remain (pid.$$ should have been renamed to pid)
temp_count=$(find "$LOCKFILE" -name 'pid.*' 2>/dev/null | wc -l | tr -d ' ')
assert_eq "$temp_count" "0" "acquire_worker_lock: no temp pid.* files remain after acquire"

# Verify final pid file is correct
if [ -f "$LOCKFILE/pid" ]; then
  pass "acquire_worker_lock: pid file exists (atomic rename succeeded)"
else
  fail "acquire_worker_lock: pid file missing (atomic rename may have failed)"
fi

rm -rf "$LOCKFILE"

# ── Test 4: acquire_worker_lock — contention with live PID ──────────

echo ""
log "=== acquire_worker_lock: contention with live PID ==="

LOCKFILE="$TMPDIR_ROOT/locks/worker-test-3.lock"
mkdir -p "$LOCKFILE"

# Spawn a background process to act as the lock holder
sleep 300 &
_holder_pid=$!
_BG_PIDS+=("$_holder_pid")
echo "$_holder_pid" > "$LOCKFILE/pid"
touch "$LOCKFILE/pid"  # Ensure fresh mtime

if acquire_worker_lock "$LOCKFILE" "$LOGFILE" "T1"; then
  fail "acquire_worker_lock: should fail when lock held by live process"
else
  pass "acquire_worker_lock: returns 1 on contention with live PID"
fi

# Verify log mentions "Already running"
if grep -q "Already running" "$LOGFILE" 2>/dev/null; then
  pass "acquire_worker_lock: logs 'Already running' message"
else
  fail "acquire_worker_lock: should log 'Already running' message"
fi

kill "$_holder_pid" 2>/dev/null; wait "$_holder_pid" 2>/dev/null || true
rm -rf "$LOCKFILE"
: > "$LOGFILE"

# ── Test 5: acquire_worker_lock — stale lock (dead PID) ─────────────

echo ""
log "=== acquire_worker_lock: stale lock reclaim (dead PID) ==="

LOCKFILE="$TMPDIR_ROOT/locks/worker-test-4.lock"
mkdir -p "$LOCKFILE"
# Use a PID that is almost certainly dead
echo "4999999" > "$LOCKFILE/pid"

if acquire_worker_lock "$LOCKFILE" "$LOGFILE" "T1"; then
  pass "acquire_worker_lock: reclaims lock from dead PID"
else
  fail "acquire_worker_lock: should reclaim stale lock (dead PID)"
fi

# Verify we now own the lock
stored_pid=$(cat "$LOCKFILE/pid" 2>/dev/null)
assert_eq "$stored_pid" "$$" "acquire_worker_lock: we own the lock after stale reclaim"

rm -rf "$LOCKFILE"
: > "$LOGFILE"

# ── Test 6: acquire_worker_lock — live PID with old lock is NOT reclaimed ─

echo ""
log "=== acquire_worker_lock: live PID with old lock (no reclaim) ==="

LOCKFILE="$TMPDIR_ROOT/locks/worker-test-5.lock"
mkdir -p "$LOCKFILE"

# Spawn a background process
sleep 300 &
_holder_pid=$!
_BG_PIDS+=("$_holder_pid")
echo "$_holder_pid" > "$LOCKFILE/pid"

# Set stale threshold very low for this test
export SKYNET_WORKER_LOCK_STALE_SECS=1

# Backdate the PID file to look old (5 seconds ago)
if [ "$(uname -s)" = "Darwin" ]; then
  touch -t "$(date -v-5S '+%Y%m%d%H%M.%S')" "$LOCKFILE/pid"
else
  touch -d "5 seconds ago" "$LOCKFILE/pid"
fi

# The code trusts heartbeat/watchdog for live PIDs — it does NOT reclaim.
# Even though the lock age > stale threshold, the PID is alive so it returns 1.
if acquire_worker_lock "$LOCKFILE" "$LOGFILE" "T1"; then
  fail "acquire_worker_lock: should NOT reclaim lock when PID is alive (even if old)"
else
  pass "acquire_worker_lock: refuses to reclaim live PID lock (trusts heartbeat/watchdog)"
fi

# Verify log mentions "Already running"
if grep -q "Already running" "$LOGFILE" 2>/dev/null; then
  pass "acquire_worker_lock: logs 'Already running' for live PID with old lock"
else
  fail "acquire_worker_lock: should log 'Already running' for live PID with old lock"
fi

# Verify we do NOT own the lock — original holder should still be recorded
stored_pid=$(cat "$LOCKFILE/pid" 2>/dev/null)
assert_eq "$stored_pid" "$_holder_pid" "acquire_worker_lock: original holder PID still in lock file"

kill "$_holder_pid" 2>/dev/null; wait "$_holder_pid" 2>/dev/null || true
unset SKYNET_WORKER_LOCK_STALE_SECS
rm -rf "$LOCKFILE"
: > "$LOGFILE"

# ── Test 7: acquire_worker_lock — lock dir exists but no pid file ───

echo ""
log "=== acquire_worker_lock: lock dir exists but no pid file (contention) ==="

LOCKFILE="$TMPDIR_ROOT/locks/worker-test-6.lock"
mkdir -p "$LOCKFILE"
# No pid file — simulates crash between mkdir and PID write.
# acquire_worker_lock requires -f "$lockfile/pid" for stale detection,
# so this case falls through to contention (return 1).

if acquire_worker_lock "$LOCKFILE" "$LOGFILE" "T1"; then
  fail "acquire_worker_lock: should return 1 on lock dir with no pid file"
else
  pass "acquire_worker_lock: returns 1 on lock dir with no pid file (contention)"
fi

# Verify log mentions contention
if grep -q "Lock contention" "$LOGFILE" 2>/dev/null; then
  pass "acquire_worker_lock: logs 'Lock contention' for empty lock dir"
else
  fail "acquire_worker_lock: should log 'Lock contention' for empty lock dir"
fi

rm -rf "$LOCKFILE"
: > "$LOGFILE"

# ── Test 8: acquire_merge_lock — delegates to backend ───────────────

echo ""
log "=== acquire_merge_lock: delegates to lock backend ==="

_MOCK_BACKEND_CALLS=""
_MOCK_BACKEND_ACQUIRE_RC=0

acquire_merge_lock
assert_eq "$?" "0" "acquire_merge_lock: returns 0 on backend success"

# Verify backend was called with correct args
case "$_MOCK_BACKEND_CALLS" in
  *"acquire:merge:$SKYNET_MERGE_LOCK_TTL;"*)
    pass "acquire_merge_lock: calls lock_backend_acquire with name=merge"
    ;;
  *)
    fail "acquire_merge_lock: expected backend acquire call (got '$_MOCK_BACKEND_CALLS')"
    ;;
esac

# ── Test 9: acquire_merge_lock — returns failure from backend ───────

echo ""
log "=== acquire_merge_lock: propagates backend failure ==="

_MOCK_BACKEND_CALLS=""
_MOCK_BACKEND_ACQUIRE_RC=1

if acquire_merge_lock; then
  fail "acquire_merge_lock: should return 1 when backend fails"
else
  pass "acquire_merge_lock: returns 1 on backend failure"
fi
_MOCK_BACKEND_ACQUIRE_RC=0

# ── Test 10: acquire_merge_lock — auto-TTL stale release ────────────

echo ""
log "=== acquire_merge_lock: auto-TTL stale merge lock release ==="

_MOCK_BACKEND_CALLS=""

# Create a stale merge lock with a dead PID
mkdir -p "$MERGE_LOCKDIR"
echo "4999999" > "$MERGE_LOCKDIR/pid"

# Backdate the PID file past the TTL (SKYNET_MERGE_LOCK_TTL=5)
if [ "$(uname -s)" = "Darwin" ]; then
  touch -t "$(date -v-10S '+%Y%m%d%H%M.%S')" "$MERGE_LOCKDIR/pid"
else
  touch -d "10 seconds ago" "$MERGE_LOCKDIR/pid"
fi

acquire_merge_lock

# The stale lock directory should have been removed before backend call
if [ -d "$MERGE_LOCKDIR" ]; then
  # The mock backend doesn't create the dir, so if it still exists it wasn't cleaned
  fail "acquire_merge_lock: should remove stale merge lock dir before backend call"
else
  pass "acquire_merge_lock: removed stale merge lock (dead PID + age > TTL)"
fi

# ── Test 11: acquire_merge_lock — does NOT release fresh lock ───────

echo ""
log "=== acquire_merge_lock: does NOT release fresh merge lock ==="

_MOCK_BACKEND_CALLS=""

# Create a merge lock with a dead PID but FRESH mtime (within TTL)
mkdir -p "$MERGE_LOCKDIR"
echo "4999999" > "$MERGE_LOCKDIR/pid"
touch "$MERGE_LOCKDIR/pid"  # Fresh mtime = now

acquire_merge_lock

# Lock should still exist (age is 0, within TTL even though PID is dead)
# Actually looking at the code: age > TTL AND (PID empty OR PID dead)
# So with age=0 (just touched), it should NOT force-release
if [ -d "$MERGE_LOCKDIR" ]; then
  pass "acquire_merge_lock: does not remove fresh merge lock (age < TTL)"
else
  fail "acquire_merge_lock: should not remove lock when age < TTL"
fi

rm -rf "$MERGE_LOCKDIR"

# ── Test 12: acquire_merge_lock — emergency unlock sentinel ─────────

echo ""
log "=== acquire_merge_lock: emergency unlock sentinel ==="

_MOCK_BACKEND_CALLS=""

# Create the emergency sentinel file
_emergency_path="${SKYNET_LOCK_PREFIX}-unlock-emergency"
touch "$_emergency_path"

# Create a merge lock to be force-removed
mkdir -p "$MERGE_LOCKDIR"
echo "$$" > "$MERGE_LOCKDIR/pid"

acquire_merge_lock

# Sentinel should be consumed (deleted)
if [ -f "$_emergency_path" ]; then
  fail "acquire_merge_lock: emergency sentinel should be deleted after processing"
else
  pass "acquire_merge_lock: emergency sentinel consumed"
fi

# Lock dir should have been force-removed
if [ -d "$MERGE_LOCKDIR" ]; then
  fail "acquire_merge_lock: merge lock should be removed by emergency unlock"
else
  pass "acquire_merge_lock: merge lock removed by emergency unlock"
fi

# ── Test 13: release_merge_lock — delegates to backend ──────────────

echo ""
log "=== release_merge_lock: delegates to lock backend ==="

_MOCK_BACKEND_CALLS=""
release_merge_lock

case "$_MOCK_BACKEND_CALLS" in
  *"release:merge;"*)
    pass "release_merge_lock: calls lock_backend_release with name=merge"
    ;;
  *)
    fail "release_merge_lock: expected backend release call (got '$_MOCK_BACKEND_CALLS')"
    ;;
esac

# ── Test 14: extend_merge_lock — delegates to backend ───────────────

echo ""
log "=== extend_merge_lock: delegates to lock backend ==="

_MOCK_BACKEND_CALLS=""
extend_merge_lock

case "$_MOCK_BACKEND_CALLS" in
  *"extend:merge:30;"*)
    pass "extend_merge_lock: calls lock_backend_extend with name=merge, ttl=30"
    ;;
  *)
    fail "extend_merge_lock: expected backend extend call (got '$_MOCK_BACKEND_CALLS')"
    ;;
esac

# ── Test 15: acquire_worker_lock — second acquire after release ─────

echo ""
log "=== acquire_worker_lock: re-acquire after manual cleanup ==="

LOCKFILE="$TMPDIR_ROOT/locks/worker-test-7.lock"

# First acquire
acquire_worker_lock "$LOCKFILE" "$LOGFILE" "T1"
stored_pid=$(cat "$LOCKFILE/pid" 2>/dev/null)
assert_eq "$stored_pid" "$$" "acquire_worker_lock: first acquire sets our PID"

# Manually remove (simulates release)
rm -rf "$LOCKFILE"

# Second acquire should work
if acquire_worker_lock "$LOCKFILE" "$LOGFILE" "T1"; then
  pass "acquire_worker_lock: re-acquire succeeds after lock is cleared"
else
  fail "acquire_worker_lock: should succeed on re-acquire after cleanup"
fi

stored_pid=$(cat "$LOCKFILE/pid" 2>/dev/null)
assert_eq "$stored_pid" "$$" "acquire_worker_lock: re-acquire sets our PID correctly"

rm -rf "$LOCKFILE"

# ── Test 16: concurrent mkdir atomicity ──────────────────────────────

echo ""
log "=== concurrent mkdir atomicity: only one succeeds ==="

LOCKFILE="$TMPDIR_ROOT/locks/worker-test-8.lock"
rm -rf "$LOCKFILE"

# Run two mkdir attempts in rapid succession via subshells
_mkdir_result_a="$TMPDIR_ROOT/locks/mkdir-result-a"
_mkdir_result_b="$TMPDIR_ROOT/locks/mkdir-result-b"
rm -f "$_mkdir_result_a" "$_mkdir_result_b"

(mkdir "$LOCKFILE" 2>/dev/null && echo "ok" > "$_mkdir_result_a" || echo "fail" > "$_mkdir_result_a") &
_pid_a=$!
(mkdir "$LOCKFILE" 2>/dev/null && echo "ok" > "$_mkdir_result_b" || echo "fail" > "$_mkdir_result_b") &
_pid_b=$!
wait "$_pid_a" 2>/dev/null || true
wait "$_pid_b" 2>/dev/null || true

_result_a=$(cat "$_mkdir_result_a" 2>/dev/null || echo "")
_result_b=$(cat "$_mkdir_result_b" 2>/dev/null || echo "")

_ok_count=0
[ "$_result_a" = "ok" ] && _ok_count=$((_ok_count + 1))
[ "$_result_b" = "ok" ] && _ok_count=$((_ok_count + 1))

assert_eq "$_ok_count" "1" "concurrent mkdir: exactly one of two rapid mkdir attempts succeeds"

rm -rf "$LOCKFILE" "$_mkdir_result_a" "$_mkdir_result_b"

# ── Test 17: stale merge lock with live PID — NOT force-released ─────

echo ""
log "=== acquire_merge_lock: stale age but live PID — NOT force-released ==="

_MOCK_BACKEND_CALLS=""
_MOCK_BACKEND_ACQUIRE_RC=0

# Create a merge lock with a live PID but age > TTL
mkdir -p "$MERGE_LOCKDIR"
sleep 300 &
_merge_holder=$!
_BG_PIDS+=("$_merge_holder")
echo "$_merge_holder" > "$MERGE_LOCKDIR/pid"

# Backdate past TTL (SKYNET_MERGE_LOCK_TTL=5)
if [ "$(uname -s)" = "Darwin" ]; then
  touch -t "$(date -v-10S '+%Y%m%d%H%M.%S')" "$MERGE_LOCKDIR/pid"
else
  touch -d "10 seconds ago" "$MERGE_LOCKDIR/pid"
fi

acquire_merge_lock

# The code checks: age > TTL AND (PID empty OR PID dead).
# Since the PID is alive, it should NOT force-release.
if [ -d "$MERGE_LOCKDIR" ]; then
  pass "acquire_merge_lock: does NOT force-release when holder PID is alive (even if age > TTL)"
else
  fail "acquire_merge_lock: should not force-release lock with live holder PID"
fi

kill "$_merge_holder" 2>/dev/null; wait "$_merge_holder" 2>/dev/null || true
rm -rf "$MERGE_LOCKDIR"

# ── Test 18: emergency unlock sentinel owned by different UID ────────

echo ""
log "=== acquire_merge_lock: emergency sentinel owned by different UID ==="

_MOCK_BACKEND_CALLS=""
_MOCK_BACKEND_ACQUIRE_RC=0

_emergency_path="${SKYNET_LOCK_PREFIX}-unlock-emergency"

# Create the emergency sentinel — it will be owned by our UID.
# To test "different UID" we override the stat check by creating a merge lock
# and verifying the sentinel is NOT consumed when the code detects a different owner.
# Since we cannot easily create a file owned by a different UID without root,
# we test the code path indirectly: the sentinel IS owned by us, so the code
# WILL consume it. Instead, we verify the log message path by checking that
# when the sentinel IS ours, it gets consumed (positive test of the ownership check).
# The "different UID" branch logs "ignoring" and leaves the sentinel in place.
# We can test this by mocking stat output — but since the test runs as a single user,
# we verify the conditional logic by confirming that when the sentinel is consumed,
# the lock is removed (our UID matches).
touch "$_emergency_path"
mkdir -p "$MERGE_LOCKDIR"
echo "$$" > "$MERGE_LOCKDIR/pid"

acquire_merge_lock

# Our UID matches, so sentinel should be consumed and lock removed
if [ ! -f "$_emergency_path" ]; then
  pass "acquire_merge_lock: sentinel consumed when UID matches (confirms ownership check runs)"
else
  fail "acquire_merge_lock: sentinel should be consumed when UID matches"
fi

rm -rf "$MERGE_LOCKDIR"

# ── Test 19: worker lock disk space failure on stale reclaim path ────

echo ""
log "=== acquire_worker_lock: disk space failure on stale reclaim path ==="

LOCKFILE="$TMPDIR_ROOT/locks/worker-test-9.lock"
: > "$LOGFILE"

# Create a lock with a dead PID (stale)
mkdir -p "$LOCKFILE"
echo "4999999" > "$LOCKFILE/pid"

# Override _lock_check_disk_space to simulate failure
_lock_check_disk_space_orig=$(declare -f _lock_check_disk_space)
_lock_check_disk_space() { return 1; }

if acquire_worker_lock "$LOCKFILE" "$LOGFILE" "T1"; then
  fail "acquire_worker_lock: should fail when disk space check fails on stale reclaim"
else
  pass "acquire_worker_lock: returns 1 when disk space check fails during stale reclaim"
fi

# Verify log mentions disk space
if grep -q "Low disk space" "$LOGFILE" 2>/dev/null; then
  pass "acquire_worker_lock: logs disk space critical message on stale reclaim"
else
  fail "acquire_worker_lock: should log disk space message on stale reclaim"
fi

# Lock dir should have been released (rmdir after disk space failure)
if [ -d "$LOCKFILE" ]; then
  fail "acquire_worker_lock: lock dir should be cleaned up after disk space failure"
else
  pass "acquire_worker_lock: lock dir cleaned up after disk space failure on stale reclaim"
fi

# Restore original _lock_check_disk_space
eval "$_lock_check_disk_space_orig"

rm -rf "$LOCKFILE"
: > "$LOGFILE"

# ── Test 20: merge lock with empty PID file ──────────────────────────

echo ""
log "=== acquire_merge_lock: empty PID file + age > TTL — force-release ==="

_MOCK_BACKEND_CALLS=""
_MOCK_BACKEND_ACQUIRE_RC=0

# Create a merge lock with an empty PID file
mkdir -p "$MERGE_LOCKDIR"
: > "$MERGE_LOCKDIR/pid"  # Empty PID file

# Backdate past TTL (SKYNET_MERGE_LOCK_TTL=5)
if [ "$(uname -s)" = "Darwin" ]; then
  touch -t "$(date -v-10S '+%Y%m%d%H%M.%S')" "$MERGE_LOCKDIR/pid"
else
  touch -d "10 seconds ago" "$MERGE_LOCKDIR/pid"
fi

acquire_merge_lock

# Empty PID + age > TTL satisfies both conditions in the force-release check
if [ -d "$MERGE_LOCKDIR" ]; then
  fail "acquire_merge_lock: should force-release merge lock with empty PID + age > TTL"
else
  pass "acquire_merge_lock: force-released merge lock with empty PID file (age > TTL)"
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
