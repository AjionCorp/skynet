#!/usr/bin/env bash
# tests/unit/crash-recovery.test.sh — Unit tests for crash recovery scenarios
#
# Tests: stale PID lock cleanup, orphaned claimed tasks, stale fixing-N recovery,
# merge lock cleanup, hung worker detection, and task state transitions.
#
# Usage: bash tests/unit/crash-recovery.test.sh

# NOTE: -e is intentionally omitted — the test uses its own PASS/FAIL counters
# and set -e conflicts with _db.sh functions that use pipes under pipefail.
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

assert_empty() {
  local val="$1" msg="$2"
  if [ -z "$val" ]; then
    pass "$msg"
  else
    fail "$msg (expected empty, got '$val')"
  fi
}

# ── Setup: create isolated environment ──────────────────────────────

TMPDIR_ROOT=$(mktemp -d)
cleanup() {
  [ -n "${_LIVE_BG_PID:-}" ] && kill "$_LIVE_BG_PID" 2>/dev/null || true
  rm -rf "$TMPDIR_ROOT"
}
trap cleanup EXIT

export SKYNET_PROJECT_DIR="$TMPDIR_ROOT"
export SKYNET_DEV_DIR="$TMPDIR_ROOT/.dev"
export SKYNET_PROJECT_NAME="test-cr"
export SKYNET_LOCK_PREFIX="$TMPDIR_ROOT/locks/skynet-test-cr"
export SKYNET_STALE_MINUTES=45
export SKYNET_MAX_WORKERS=4
export SKYNET_MAX_FIXERS=3
export SKYNET_MAIN_BRANCH="main"

mkdir -p "$SKYNET_DEV_DIR" "$TMPDIR_ROOT/locks"

# Stub log to capture output
LOG_CAPTURE="$TMPDIR_ROOT/log-capture.txt"
: > "$LOG_CAPTURE"
log() { echo "$*" >> "$LOG_CAPTURE"; }

# Source modules under test
source "$REPO_ROOT/scripts/_compat.sh"
source "$REPO_ROOT/scripts/_db.sh"

# _db_sep uses \x1f (Unit Separator), not '|'. Use this for output parsing.
SEP=$'\x1f'
db_init

# Define is_running (from watchdog.sh)
is_running() {
  local lockfile="$1"
  local pid=""
  if [ -d "$lockfile" ] && [ -f "$lockfile/pid" ]; then
    pid=$(cat "$lockfile/pid" 2>/dev/null || echo "")
  elif [ -f "$lockfile" ]; then
    pid=$(cat "$lockfile" 2>/dev/null || echo "")
  fi
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

# PID helpers.
# LIVE_TEST_PID: a long-running background process (cleaned up on exit).
# DEAD_TEST_PID: a PID that is guaranteed to not be running.
_LIVE_BG_PID=""

_start_live_bg() {
  if [ -z "$_LIVE_BG_PID" ] || ! kill -0 "$_LIVE_BG_PID" 2>/dev/null; then
    sleep 86400 &
    _LIVE_BG_PID=$!
  fi
}

# Find a PID that's definitely dead (iterate from a high number down)
_find_dead_pid() {
  local candidate=99999
  while kill -0 "$candidate" 2>/dev/null; do
    candidate=$((candidate - 1))
  done
  echo "$candidate"
}

# ============================================================
# TEST 1: Stale PID lock (dead PID in lock dir → lock removed)
# ============================================================

echo ""
printf "  %s\n" "=== Test 1: Stale PID lock cleanup ==="

# Create a lock dir with a dead PID
LOCK_DIR="${SKYNET_LOCK_PREFIX}-dev-worker-1.lock"
mkdir -p "$LOCK_DIR"
DEAD_PID=$(_find_dead_pid)
echo "$DEAD_PID" > "$LOCK_DIR/pid"

# is_running should return false for dead PID
if is_running "$LOCK_DIR"; then
  fail "stale PID: is_running should return false for dead PID"
else
  pass "stale PID: is_running returns false for dead PID"
fi

# Create a lock with a live PID (use our long-running background process)
_start_live_bg
echo "$_LIVE_BG_PID" > "$LOCK_DIR/pid"

if is_running "$LOCK_DIR"; then
  pass "live PID: is_running returns true for live PID"
else
  fail "live PID: is_running should return true for live PID"
fi

# Overwrite with a dead PID to simulate lock becoming stale
echo "$DEAD_PID" > "$LOCK_DIR/pid"
if is_running "$LOCK_DIR"; then
  fail "stale PID: is_running should return false for stale lock"
else
  pass "stale PID: is_running returns false for stale lock"
  # Watchdog would clean this up
  rm -rf "$LOCK_DIR"
  [ ! -d "$LOCK_DIR" ] && pass "stale PID: lock dir removed after dead PID detected" || fail "stale PID: lock dir should be removed"
fi

# Test: missing PID file in lock dir (crash between mkdir and PID write)
mkdir -p "$LOCK_DIR"
# No pid file written
if is_running "$LOCK_DIR"; then
  fail "missing PID file: is_running should return false"
else
  pass "missing PID file: is_running returns false (crash between mkdir and PID write)"
fi
rm -rf "$LOCK_DIR"

# ============================================================
# TEST 2: Orphaned claimed task recovery
# ============================================================

echo ""
printf "  %s\n" "=== Test 2: Orphaned claimed task recovery ==="

# Clean DB
sqlite3 "$DB_PATH" "DELETE FROM tasks; DELETE FROM workers;"

# Add a task and claim it
T_ID=$(db_add_task "Orphaned task test" "FEAT" "" "top")
db_claim_next_task 1 >/dev/null

# Verify it's claimed
STATUS=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$T_ID;")
assert_eq "$STATUS" "claimed" "orphan: task is claimed"

# Simulate orphan: set claimed_at to >120s ago, no active worker
sqlite3 "$DB_PATH" "UPDATE tasks SET claimed_at = datetime('now', '-200 seconds') WHERE id=$T_ID;"

# Verify the task would be detected as orphaned
ORPHANED=$(sqlite3 "$DB_PATH" "
  SELECT t.id FROM tasks t
  WHERE t.status = 'claimed' AND t.worker_id IS NOT NULL
    AND t.claimed_at < datetime('now', '-120 seconds')
    AND NOT EXISTS (
      SELECT 1 FROM workers w
      WHERE w.id = t.worker_id AND w.status = 'in_progress' AND w.current_task_id = t.id
    );
")
assert_not_empty "$ORPHANED" "orphan: detected by reconciliation query"

# Unclaim the task (simulating watchdog reconciliation)
db_unclaim_task "$T_ID"
STATUS2=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$T_ID;")
assert_eq "$STATUS2" "pending" "orphan: task reset to pending after unclaim"

WID=$(sqlite3 "$DB_PATH" "SELECT worker_id FROM tasks WHERE id=$T_ID;")
assert_empty "$WID" "orphan: worker_id cleared"

# Test: claim within 120s guard is NOT detected as orphaned
T_ID2=$(db_add_task "Fresh claim test" "FEAT" "" "top")
db_claim_next_task 2 >/dev/null
FRESH_ORPHAN=$(sqlite3 "$DB_PATH" "
  SELECT t.id FROM tasks t
  WHERE t.status = 'claimed' AND t.worker_id IS NOT NULL
    AND t.claimed_at < datetime('now', '-120 seconds')
    AND NOT EXISTS (
      SELECT 1 FROM workers w
      WHERE w.id = t.worker_id AND w.status = 'in_progress' AND w.current_task_id = t.id
    );
")
assert_empty "$FRESH_ORPHAN" "orphan: fresh claim (<120s) not detected as orphaned"

# ============================================================
# TEST 3: Stale fixing-N recovery (fixer dead → reset to failed)
# ============================================================

echo ""
printf "  %s\n" "=== Test 3: Stale fixing-N recovery ==="

sqlite3 "$DB_PATH" "DELETE FROM tasks;"

# Add a failed task and claim it as fixing
FIX_ID=$(db_add_task "Stale fixer test" "FIX" "" "top")
sqlite3 "$DB_PATH" "UPDATE tasks SET status='failed' WHERE id=$FIX_ID;"
db_claim_failure "$FIX_ID" 1

STATUS=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$FIX_ID;")
assert_eq "$STATUS" "fixing-1" "fixing: task is in fixing-1 status"

# Simulate stale: set updated_at to >120s ago
sqlite3 "$DB_PATH" "UPDATE tasks SET updated_at = datetime('now', '-200 seconds') WHERE id=$FIX_ID;"

# No fixer lock exists → fixer is dead
FIXER_LOCK="${SKYNET_LOCK_PREFIX}-task-fixer.lock"
rm -rf "$FIXER_LOCK" 2>/dev/null || true

# Query should detect this as stale
STALE_FIXING=$(sqlite3 -separator "|" "$DB_PATH" "
  SELECT id, title, fixer_id
  FROM tasks
  WHERE status LIKE 'fixing-%'
    AND updated_at < datetime('now', '-120 seconds');
" 2>/dev/null || true)
assert_not_empty "$STALE_FIXING" "fixing: stale task detected by query"

# Verify fixer is not running
if is_running "$FIXER_LOCK"; then
  fail "fixing: fixer lock should not exist"
else
  pass "fixing: fixer confirmed dead (no lock)"
fi

# Reset to failed (simulating watchdog reconciliation)
_sf_int_id=$(_sql_int "$FIX_ID")
sqlite3 "$DB_PATH" "
  UPDATE tasks SET status='failed', fixer_id=NULL, updated_at=datetime('now')
  WHERE id=$_sf_int_id AND status LIKE 'fixing-%';
"
STATUS2=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$FIX_ID;")
assert_eq "$STATUS2" "failed" "fixing: stale task reset to failed"

FIXER_ID=$(sqlite3 "$DB_PATH" "SELECT fixer_id FROM tasks WHERE id=$FIX_ID;")
assert_empty "$FIXER_ID" "fixing: fixer_id cleared"

# Test: live fixer should NOT trigger reconciliation
FIX_ID2=$(db_add_task "Active fixer test" "FIX" "" "top")
sqlite3 "$DB_PATH" "UPDATE tasks SET status='failed' WHERE id=$FIX_ID2;"
db_claim_failure "$FIX_ID2" 2
sqlite3 "$DB_PATH" "UPDATE tasks SET updated_at = datetime('now', '-200 seconds') WHERE id=$FIX_ID2;"

# Create a live fixer lock
FIXER_LOCK2="${SKYNET_LOCK_PREFIX}-task-fixer-2.lock"
mkdir -p "$FIXER_LOCK2"
_start_live_bg
echo "$_LIVE_BG_PID" > "$FIXER_LOCK2/pid"

if is_running "$FIXER_LOCK2"; then
  pass "fixing: live fixer detected — should skip reconciliation"
else
  fail "fixing: live fixer should be detected"
fi

# Status should still be fixing-2 (not reconciled)
STATUS3=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$FIX_ID2;")
assert_eq "$STATUS3" "fixing-2" "fixing: live fixer task not reconciled"

rm -rf "$FIXER_LOCK2"

# ============================================================
# TEST 4: Merge lock cleanup (dead PID or missing PID file)
# ============================================================

echo ""
printf "  %s\n" "=== Test 4: Merge lock cleanup ==="

MERGE_LOCK="${SKYNET_LOCK_PREFIX}-merge.lock"

# Case A: merge lock with dead PID
mkdir -p "$MERGE_LOCK"
DEAD_ML_PID=$(_find_dead_pid)
echo "$DEAD_ML_PID" > "$MERGE_LOCK/pid"

[ -d "$MERGE_LOCK" ] && pass "merge lock: lock dir exists" || fail "merge lock: lock dir should exist"

ML_PID=$(cat "$MERGE_LOCK/pid" 2>/dev/null || echo "")
if ! kill -0 "$ML_PID" 2>/dev/null; then
  pass "merge lock: holder PID is dead"
  rm -rf "$MERGE_LOCK"
  [ ! -d "$MERGE_LOCK" ] && pass "merge lock: cleaned up dead-PID lock" || fail "merge lock: should be cleaned up"
else
  fail "merge lock: PID should be dead"
fi

# Case B: merge lock with no PID file (crash between mkdir and PID write)
mkdir -p "$MERGE_LOCK"
# Deliberately don't write a PID file
ML_PID2=""
[ -f "$MERGE_LOCK/pid" ] && ML_PID2=$(cat "$MERGE_LOCK/pid" 2>/dev/null || echo "")
if [ -z "$ML_PID2" ]; then
  pass "merge lock: no PID file detected (crash scenario)"
  rm -rf "$MERGE_LOCK"
  [ ! -d "$MERGE_LOCK" ] && pass "merge lock: cleaned up no-PID lock" || fail "merge lock: should be cleaned up"
else
  fail "merge lock: should have no PID file"
fi

# Case C: merge lock with live PID — should NOT be cleaned
mkdir -p "$MERGE_LOCK"
_start_live_bg
echo "$_LIVE_BG_PID" > "$MERGE_LOCK/pid"

ML_PID3=$(cat "$MERGE_LOCK/pid" 2>/dev/null || echo "")
if kill -0 "$ML_PID3" 2>/dev/null; then
  pass "merge lock: live PID holder not cleaned"
  [ -d "$MERGE_LOCK" ] && pass "merge lock: lock preserved for live holder" || fail "merge lock: should be preserved"
else
  fail "merge lock: PID should be alive"
fi

rm -rf "$MERGE_LOCK"

# ============================================================
# TEST 5: Hung worker detection (heartbeat fresh, progress stale)
# ============================================================

echo ""
printf "  %s\n" "=== Test 5: Hung worker detection ==="

sqlite3 "$DB_PATH" "DELETE FROM workers;"
NOW=$(date +%s)

# Worker 1: fresh heartbeat + fresh progress → normal
db_set_worker_status 1 "dev" "in_progress" "" "Normal task" ""
sqlite3 "$DB_PATH" "UPDATE workers SET heartbeat_epoch = $NOW, progress_epoch = $NOW WHERE id=1;"

# Worker 2: fresh heartbeat + stale progress → HUNG
db_set_worker_status 2 "dev" "in_progress" "" "Hung task" ""
STALE_PROGRESS=$(( NOW - 4000 ))
sqlite3 "$DB_PATH" "UPDATE workers SET heartbeat_epoch = $NOW, progress_epoch = $STALE_PROGRESS WHERE id=2;"

# Worker 3: stale heartbeat + stale progress → stale (not hung, different detection)
db_set_worker_status 3 "dev" "in_progress" "" "Stale task" ""
STALE_HB=$(( NOW - 4000 ))
sqlite3 "$DB_PATH" "UPDATE workers SET heartbeat_epoch = $STALE_HB, progress_epoch = $STALE_HB WHERE id=3;"

# Worker 4: idle → should not appear
db_set_worker_status 4 "dev" "idle" "" "" ""

# Check if db_get_hung_workers exists
if declare -f db_get_hung_workers >/dev/null 2>&1; then
  HUNG=$(db_get_hung_workers 2700)
  assert_contains "$HUNG" "2${SEP}" "hung worker: detects worker 2 as hung"

  HUNG_CHECK1=$(echo "$HUNG" | grep "^1${SEP}" || true)
  assert_empty "$HUNG_CHECK1" "hung worker: normal worker 1 not flagged"

  HUNG_CHECK4=$(echo "$HUNG" | grep "^4${SEP}" || true)
  assert_empty "$HUNG_CHECK4" "hung worker: idle worker 4 not flagged"
else
  # Fallback: test via direct SQL
  HUNG=$(sqlite3 -separator "|" "$DB_PATH" "
    SELECT id, status, task_title, heartbeat_epoch, progress_epoch
    FROM workers
    WHERE status = 'in_progress'
      AND heartbeat_epoch > $(( NOW - 2700 ))
      AND progress_epoch < $(( NOW - 2700 ));
  ")
  assert_contains "$HUNG" "2|" "hung worker: SQL detects worker 2 as hung"

  HUNG_CHECK1=$(echo "$HUNG" | grep "^1|" || true)
  assert_empty "$HUNG_CHECK1" "hung worker: normal worker 1 not flagged by SQL"
fi

# Stale heartbeat detection (different from hung)
STALE=$(db_get_stale_heartbeats 2700)
assert_contains "$STALE" "3${SEP}" "stale heartbeat: detects worker 3"

STALE_CHECK2=$(echo "$STALE" | grep "^2${SEP}" || true)
assert_empty "$STALE_CHECK2" "stale heartbeat: worker 2 NOT stale (heartbeat is fresh)"

# ============================================================
# TEST 6: Task state transitions (full lifecycle)
# ============================================================

echo ""
printf "  %s\n" "=== Test 6: Task state transitions ==="

sqlite3 "$DB_PATH" "DELETE FROM tasks;"

# --- Path A: pending → claimed → completed ---
A_ID=$(db_add_task "Happy path task" "FEAT" "" "top")
STATUS=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$A_ID;")
assert_eq "$STATUS" "pending" "lifecycle A: starts as pending"

db_claim_next_task 1 >/dev/null
STATUS=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$A_ID;")
assert_eq "$STATUS" "claimed" "lifecycle A: claimed by worker"

db_complete_task "$A_ID" "dev/happy-path" "2m" 120 "success"
STATUS=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$A_ID;")
assert_eq "$STATUS" "completed" "lifecycle A: completed after merge"

# --- Path B: pending → claimed → failed → fixing-1 → fixed ---
B_ID=$(db_add_task "Fix path task" "FIX" "" "top")
sqlite3 "$DB_PATH" "UPDATE tasks SET status='claimed', worker_id=1 WHERE id=$B_ID;"

db_fail_task "$B_ID" "dev/fix-path" "typecheck error"
STATUS=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$B_ID;")
assert_eq "$STATUS" "failed" "lifecycle B: failed after gate failure"

db_claim_failure "$B_ID" 1
STATUS=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$B_ID;")
assert_eq "$STATUS" "fixing-1" "lifecycle B: claimed by fixer"

db_fix_task "$B_ID" "dev/fix-path" 1 "fixed on first try"
STATUS=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$B_ID;")
assert_eq "$STATUS" "fixed" "lifecycle B: fixed after successful fixer merge"

# --- Path C: pending → claimed → failed → fixing → failed → blocked ---
C_ID=$(db_add_task "Block path task" "FIX" "" "top")
sqlite3 "$DB_PATH" "UPDATE tasks SET status='claimed', worker_id=1 WHERE id=$C_ID;"
db_fail_task "$C_ID" "dev/block-path" "build error"

# Simulate 3 failed fix attempts
for attempt in 1 2 3; do
  db_claim_failure "$C_ID" 1 2>/dev/null || true
  # Reset back to failed (simulating fixer failure)
  sqlite3 "$DB_PATH" "UPDATE tasks SET status='failed', fixer_id=NULL, attempts=$attempt WHERE id=$C_ID;"
done

# After max attempts, block the task
db_block_task "$C_ID"
STATUS=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$C_ID;")
assert_eq "$STATUS" "blocked" "lifecycle C: blocked after max fix attempts"

# --- Path D: pending → claimed → failed → superseded ---
D_COMP_ID=$(db_add_task "Already done" "FEAT" "" "top")
sqlite3 "$DB_PATH" "UPDATE tasks SET status='completed', normalized_root='already done' WHERE id=$D_COMP_ID;"

D_FAIL_ID=$(db_add_task "Already done retry" "FEAT" "" "top")
sqlite3 "$DB_PATH" "UPDATE tasks SET status='failed', normalized_root='already done' WHERE id=$D_FAIL_ID;"

CHANGES=$(db_auto_supersede_completed)
STATUS=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$D_FAIL_ID;")
assert_eq "$STATUS" "superseded" "lifecycle D: failed task superseded by completed duplicate"

# --- Path E: claimed → pending (unclaim via crash recovery) ---
E_ID=$(db_add_task "Crash recovery task" "FEAT" "" "top")
db_claim_next_task 3 >/dev/null
STATUS=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$E_ID;")
assert_eq "$STATUS" "claimed" "lifecycle E: task claimed"

db_unclaim_task "$E_ID"
STATUS=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$E_ID;")
assert_eq "$STATUS" "pending" "lifecycle E: unclaimed back to pending"

# --- Verify terminal states are truly terminal ---
A_STATUS=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$A_ID;")
B_STATUS=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$B_ID;")
C_STATUS=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$C_ID;")
D_STATUS=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$D_FAIL_ID;")
assert_eq "$A_STATUS" "completed" "terminal: completed is stable"
assert_eq "$B_STATUS" "fixed" "terminal: fixed is stable"
assert_eq "$C_STATUS" "blocked" "terminal: blocked is stable"
assert_eq "$D_STATUS" "superseded" "terminal: superseded is stable"

# ============================================================
# TEST 7: flock acquire and release
# ============================================================

echo ""
printf "  %s\n" "=== Test 7: flock acquire and release ==="

# Test flock acquire and release
_acquire_file_lock "$TMPDIR_ROOT/test.flock" 5
assert_eq "$?" "0" "flock: acquire succeeds"
_release_file_lock
assert_eq "$?" "0" "flock: release succeeds"

# ============================================================
# TEST 8: flock auto-release on SIGKILL
# ============================================================

echo ""
printf "  %s\n" "=== Test 8: flock auto-release on SIGKILL ==="

# Test auto-release on SIGKILL
# On macOS, the lock is held by a perl helper subprocess. Killing only the
# subshell orphans the perl process (still holding the lock). To simulate
# a real process-group death (what happens when a worker crashes), we kill
# the entire process group.
bash -c '
  source "'"$REPO_ROOT"'/scripts/_compat.sh"
  _acquire_file_lock "'"$TMPDIR_ROOT"'/kill-test.flock" 5
  echo $$ > "'"$TMPDIR_ROOT"'/kill-test-pid.txt"
  sleep 60
' &
_child_pid=$!
sleep 1  # Let child acquire lock

# Kill the entire process group (catches perl helper on macOS)
# Use pkill -P to kill children first, then the parent
pkill -9 -P "$_child_pid" 2>/dev/null || true
kill -9 "$_child_pid" 2>/dev/null || true
wait "$_child_pid" 2>/dev/null || true
sleep 0.5

# Now we should be able to acquire the same lock
_acquire_file_lock "$TMPDIR_ROOT/kill-test.flock" 5
if [ $? -eq 0 ]; then
  pass "flock: auto-release on SIGKILL"
  _release_file_lock
else
  fail "flock: should auto-release after SIGKILL"
fi

# ============================================================
# TEST 9: flock contention (second process waits then acquires)
# ============================================================

echo ""
printf "  %s\n" "=== Test 9: flock contention ==="

# Test lock contention -- second process waits, then acquires after first releases
_acquire_file_lock "$TMPDIR_ROOT/contention.flock" 30
(
  source "$REPO_ROOT/scripts/_compat.sh"
  _acquire_file_lock "$TMPDIR_ROOT/contention.flock" 10
  echo "ACQUIRED" > "$TMPDIR_ROOT/contention-result.txt"
  _release_file_lock
) &
_contention_pid=$!
sleep 1
_release_file_lock  # Release from parent
wait "$_contention_pid" 2>/dev/null || true

if [ -f "$TMPDIR_ROOT/contention-result.txt" ] && grep -q "ACQUIRED" "$TMPDIR_ROOT/contention-result.txt"; then
  pass "flock: contention — second process acquires after first releases"
else
  fail "flock: contention — second process should have acquired lock"
fi

# ============================================================
# TEST: Lock backend interface (file backend)
# ============================================================

echo ""
printf "  %s\n" "=== lock backend interface ==="

# Source lock backend (needed for standalone test — _config.sh sources it in production)
export SKYNET_SCRIPTS_DIR="$REPO_ROOT/scripts"
source "$REPO_ROOT/scripts/_lock_backend.sh"

lock_backend_acquire "test-backend" 5
_lb_rc=$?
assert_eq "$_lb_rc" "0" "lock_backend: acquire succeeds"

lock_backend_check "test-backend"
_lc_rc=$?
assert_eq "$_lc_rc" "0" "lock_backend: check confirms lock held"

lock_backend_release "test-backend"
pass "lock_backend: release succeeds"

# Verify lock released (check should fail now)
lock_backend_check "test-backend"
_lr_rc=$?
[ "$_lr_rc" -ne 0 ] && pass "lock_backend: check fails after release" || fail "lock_backend: should not be held after release"

# ── Summary ──────────────────────────────────────────────────────

echo ""
TOTAL=$((PASS + FAIL))
printf "  Results: %s/%s passed, %s failed\n" "$PASS" "$TOTAL" "$FAIL"
if [ $FAIL -eq 0 ]; then
  printf "  \033[32mAll checks passed!\033[0m\n"
else
  printf "  \033[31mSome checks failed!\033[0m\n"
  exit 1
fi
