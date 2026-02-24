#!/usr/bin/env bash
# tests/unit/file-lock.test.sh — Unit tests for scripts/lock-backends/file.sh
#
# Tests the file-based lock backend (mkdir path) in isolation.
# Forces SKYNET_USE_FLOCK=false to test the portable mkdir-based code path.
#
# Usage: bash tests/unit/file-lock.test.sh

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
  rm -rf "$TMPDIR_ROOT"
}
trap cleanup EXIT

# Minimal config stubs
export SKYNET_PROJECT_NAME="test-file-lock"
export SKYNET_LOCK_PREFIX="$TMPDIR_ROOT/locks/skynet-test"
export SKYNET_USE_FLOCK="false"  # Test mkdir-based path (more portable)
export SKYNET_LOCK_TTL_SECS="600"
export SKYNET_SCRIPTS_DIR="$REPO_ROOT/scripts"

# Create the locks directory
mkdir -p "$TMPDIR_ROOT/locks"

# Source the file lock backend
source "$REPO_ROOT/scripts/lock-backends/file.sh"

# ── Test 1: lock_backend_acquire succeeds when lock is free ─────────

echo ""
log "=== lock_backend_acquire: success when lock is free ==="

if lock_backend_acquire "test-lock-1" 5; then
  pass "lock_backend_acquire: succeeds when lock is free"
else
  fail "lock_backend_acquire: should succeed when lock is free"
fi

# Verify the lock directory and PID file were created
lockdir="$SKYNET_LOCK_PREFIX-test-lock-1.lock"
if [ -d "$lockdir" ] && [ -f "$lockdir/pid" ]; then
  stored_pid=$(cat "$lockdir/pid" 2>/dev/null)
  assert_eq "$stored_pid" "$$" "lock_backend_acquire: PID file contains our PID"
else
  fail "lock_backend_acquire: lock directory or PID file not created"
fi

# Clean up
rm -rf "$lockdir"

# ── Test 2: lock_backend_acquire fails when lock is held ────────────

echo ""
log "=== lock_backend_acquire: fails when held by another PID ==="

lockdir="$SKYNET_LOCK_PREFIX-test-lock-2.lock"
mkdir -p "$lockdir"
# Spawn a background process that we can detect as alive via kill -0
sleep 300 &
_holder_pid=$!
echo "$_holder_pid" > "$lockdir/pid"
# Touch the PID file so it's fresh (not stale)
touch "$lockdir/pid"

# Acquire with 1-second timeout (will try 2 attempts then fail)
if lock_backend_acquire "test-lock-2" 1 2>/dev/null; then
  fail "lock_backend_acquire: should fail when lock is held by another PID"
else
  pass "lock_backend_acquire: fails on timeout when lock is held by another"
fi

# Clean up
kill "$_holder_pid" 2>/dev/null; wait "$_holder_pid" 2>/dev/null || true
rm -rf "$lockdir"

# ── Test 3: lock_backend_release releases when we own the lock ──────

echo ""
log "=== lock_backend_release: releases when we own the lock ==="

lockdir="$SKYNET_LOCK_PREFIX-test-lock-3.lock"
# Acquire lock first
lock_backend_acquire "test-lock-3" 5

if [ -d "$lockdir" ]; then
  pass "lock_backend_release: lock exists before release"
else
  fail "lock_backend_release: lock should exist before release"
fi

# Release the lock
lock_backend_release "test-lock-3"

if [ -d "$lockdir" ]; then
  fail "lock_backend_release: lock directory should be removed after release"
else
  pass "lock_backend_release: lock directory removed after owner releases"
fi

# ── Test 4: lock_backend_release does NOT release when another owns ─

echo ""
log "=== lock_backend_release: does NOT release when another process owns ==="

lockdir="$SKYNET_LOCK_PREFIX-test-lock-4.lock"
mkdir -p "$lockdir"
# Spawn a background process to act as the lock holder
sleep 300 &
_holder_pid4=$!
echo "$_holder_pid4" > "$lockdir/pid"

# Try to release (we are $$, not the holder)
lock_backend_release "test-lock-4"

if [ -d "$lockdir" ] && [ -f "$lockdir/pid" ]; then
  stored_pid=$(cat "$lockdir/pid" 2>/dev/null)
  assert_eq "$stored_pid" "$_holder_pid4" "lock_backend_release: non-owner release leaves lock intact"
else
  fail "lock_backend_release: non-owner release should not remove lock"
fi

# Clean up
kill "$_holder_pid4" 2>/dev/null; wait "$_holder_pid4" 2>/dev/null || true
rm -rf "$lockdir"

# ── Test 5: lock_backend_check returns 0 when we own, 1 otherwise ──

echo ""
log "=== lock_backend_check: ownership detection ==="

lockdir="$SKYNET_LOCK_PREFIX-test-lock-5.lock"

# Acquire lock
lock_backend_acquire "test-lock-5" 5

if lock_backend_check "test-lock-5"; then
  pass "lock_backend_check: returns 0 when we own the lock"
else
  fail "lock_backend_check: should return 0 when we own the lock"
fi

# Overwrite PID file with a different (non-existent but valid) PID
sleep 300 &
_holder_pid5=$!
echo "$_holder_pid5" > "$lockdir/pid"

if lock_backend_check "test-lock-5"; then
  fail "lock_backend_check: should return 1 when another process owns the lock"
else
  pass "lock_backend_check: returns 1 when we don't own the lock"
fi

# Clean up background process
kill "$_holder_pid5" 2>/dev/null; wait "$_holder_pid5" 2>/dev/null || true

# Test non-existent lock
rm -rf "$lockdir"
if lock_backend_check "test-lock-nonexistent"; then
  fail "lock_backend_check: should return 1 when lock doesn't exist"
else
  pass "lock_backend_check: returns 1 when lock doesn't exist"
fi

# ── Test 6: Stale lock cleanup (lock held by dead PID) ──────────────

echo ""
log "=== Stale lock: lock held by dead PID gets force-released ==="

lockdir="$SKYNET_LOCK_PREFIX-test-lock-6.lock"
mkdir -p "$lockdir"
# Use a PID that is almost certainly not running (very high number)
echo "4999999" > "$lockdir/pid"

# The acquire should detect the dead PID and force-release the stale lock
if lock_backend_acquire "test-lock-6" 5; then
  pass "lock_backend_acquire: succeeds after force-releasing stale lock (dead PID)"
else
  fail "lock_backend_acquire: should force-release stale lock held by dead PID"
fi

# Verify we now own the lock
if [ -d "$lockdir" ] && [ -f "$lockdir/pid" ]; then
  stored_pid=$(cat "$lockdir/pid" 2>/dev/null)
  assert_eq "$stored_pid" "$$" "lock_backend_acquire: we own the lock after stale release"
else
  fail "lock_backend_acquire: lock directory should exist after stale release"
fi

# Clean up
rm -rf "$lockdir"


# ── Test 7: Lock directory format — pid file contains numeric PID ────

echo ""
log "=== TEST-P3-4: Lock dir format — contains pid file with numeric PID ==="

lockdir="$SKYNET_LOCK_PREFIX-test-lock-7.lock"
lock_backend_acquire "test-lock-7" 5

# Verify directory structure
if [ -d "$lockdir" ]; then
  pass "lock format: lock path is a directory"
else
  fail "lock format: lock path should be a directory"
fi

if [ -f "$lockdir/pid" ]; then
  pass "lock format: lock dir contains a 'pid' file"
else
  fail "lock format: lock dir should contain a 'pid' file"
fi

# Verify PID is numeric
stored_pid=$(cat "$lockdir/pid" 2>/dev/null)
case "$stored_pid" in
  ''|*[!0-9]*)
    fail "lock format: PID file should contain only digits (got '$stored_pid')"
    ;;
  *)
    pass "lock format: PID file contains numeric value ($stored_pid)"
    ;;
esac

# Verify PID matches current process
assert_eq "$stored_pid" "$$" "lock format: PID file matches current process PID"

# Clean up
rm -rf "$lockdir"

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
