#!/usr/bin/env bash
# tests/integration/watchdog-crash-recovery.test.sh — End-to-end crash recovery
#
# Exercises the full crash-recovery lifecycle:
#   1. Seed tasks → claim → simulate worker crash (stale lock, orphan task, orphan worktree)
#   2. Run crash recovery phases
#   3. Verify state cleanup (locks removed, tasks unclaimed, worktrees pruned)
#   4. Re-claim recovered tasks and complete them (proves the pipeline continues)
#
# Requirements: git, sqlite3, bash
# Usage: bash tests/integration/watchdog-crash-recovery.test.sh

# NOTE: -e is intentionally omitted — the test uses its own PASS/FAIL counters
# and set -e conflicts with _db.sh functions that use pipes under pipefail.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PASS=0
FAIL=0

# Test output helpers (prefixed with _t to avoid collision with pipeline log())
_tlog()  { printf "  %s\n" "$*"; }
pass() { PASS=$((PASS + 1)); printf "  \033[32m✓\033[0m %s\n" "$*"; }
fail() { FAIL=$((FAIL + 1)); printf "  \033[31m✗\033[0m %s\n" "$*"; }

# log() used by pipeline modules — suppress initially
log() { :; }

assert_eq() {
  local actual="$1" expected="$2" msg="$3"
  if [ "$actual" = "$expected" ]; then pass "$msg"
  else fail "$msg (expected '$expected', got '$actual')"; fi
}

assert_contains() {
  local haystack="$1" needle="$2" msg="$3"
  if echo "$haystack" | grep -qF "$needle"; then pass "$msg"
  else fail "$msg (expected to contain '$needle')"; fi
}

assert_not_empty() {
  local val="$1" msg="$2"
  if [ -n "$val" ]; then pass "$msg"
  else fail "$msg (was empty)"; fi
}

assert_empty() {
  local val="$1" msg="$2"
  if [ -z "$val" ]; then pass "$msg"
  else fail "$msg (expected empty, got '$val')"; fi
}

# ── Setup: create isolated environment ──────────────────────────────

TMPDIR_ROOT=$(mktemp -d)
cleanup() {
  [ -n "${_LIVE_BG_PID:-}" ] && kill "$_LIVE_BG_PID" 2>/dev/null || true
  rm -rf "/tmp/skynet-test-cr-integ-$$"* 2>/dev/null || true
  rm -rf "$TMPDIR_ROOT"
}
trap cleanup EXIT

echo ""
_tlog "=== Setup: creating isolated git environment ==="

# Create bare remote and clone as project
git init --bare "$TMPDIR_ROOT/remote.git" >/dev/null 2>&1
git -C "$TMPDIR_ROOT/remote.git" symbolic-ref HEAD refs/heads/main
git clone "$TMPDIR_ROOT/remote.git" "$TMPDIR_ROOT/project" >/dev/null 2>&1

cd "$TMPDIR_ROOT/project"
git checkout -b main 2>/dev/null || true
git config user.email "test@integration.test"
git config user.name "Integration Test"
echo "# Test Project" > README.md
git add README.md
git commit -m "Initial commit" >/dev/null 2>&1
git push -u origin main >/dev/null 2>&1

# Create .dev/ and config
mkdir -p "$TMPDIR_ROOT/project/.dev"

cat > "$TMPDIR_ROOT/project/.dev/skynet.config.sh" <<CONF
export SKYNET_PROJECT_NAME="test-cr-integ"
export SKYNET_PROJECT_DIR="$TMPDIR_ROOT/project"
export SKYNET_DEV_DIR="$TMPDIR_ROOT/project/.dev"
export SKYNET_LOCK_PREFIX="/tmp/skynet-test-cr-integ-$$"
export SKYNET_MAIN_BRANCH="main"
export SKYNET_MAX_WORKERS=4
export SKYNET_MAX_FIXERS=2
export SKYNET_MAX_TASKS_PER_RUN=1
export SKYNET_AGENT_PLUGIN="echo"
export SKYNET_TYPECHECK_CMD="true"
export SKYNET_GATE_1="true"
export SKYNET_POST_MERGE_TYPECHECK="false"
export SKYNET_POST_MERGE_SMOKE="false"
export SKYNET_BRANCH_PREFIX="dev/"
export SKYNET_STALE_MINUTES=45
export SKYNET_AGENT_TIMEOUT_MINUTES=5
export SKYNET_DEV_PORT=13200
export SKYNET_INSTALL_CMD="true"
export SKYNET_TG_ENABLED="false"
export SKYNET_NOTIFY_CHANNELS=""
CONF

ln -s "$REPO_ROOT/scripts" "$TMPDIR_ROOT/project/.dev/scripts"

touch "$TMPDIR_ROOT/project/.dev/backlog.md"
touch "$TMPDIR_ROOT/project/.dev/completed.md"
touch "$TMPDIR_ROOT/project/.dev/failed-tasks.md"
touch "$TMPDIR_ROOT/project/.dev/blockers.md"
touch "$TMPDIR_ROOT/project/.dev/mission.md"

# Set environment
export SKYNET_DEV_DIR="$TMPDIR_ROOT/project/.dev"
export SKYNET_PROJECT_DIR="$TMPDIR_ROOT/project"
export SKYNET_PROJECT_NAME="test-cr-integ"
export SKYNET_LOCK_PREFIX="/tmp/skynet-test-cr-integ-$$"
export SKYNET_MAIN_BRANCH="main"
export SKYNET_MAX_WORKERS=4
export SKYNET_MAX_FIXERS=2
export SKYNET_STALE_MINUTES=45
export SKYNET_BRANCH_PREFIX="dev/"
export SKYNET_INSTALL_CMD="true"
export SKYNET_TYPECHECK_CMD="true"
export SKYNET_POST_MERGE_TYPECHECK="false"
export SKYNET_POST_MERGE_SMOKE="false"
export SKYNET_TG_ENABLED="false"
export SKYNET_NOTIFY_CHANNELS=""
export SKYNET_DEV_PORT=13200
export SKYNET_AGENT_TIMEOUT_MINUTES=5

PROJECT_DIR="$SKYNET_PROJECT_DIR"
DEV_DIR="$SKYNET_DEV_DIR"
SCRIPTS_DIR="$SKYNET_DEV_DIR/scripts"
BACKLOG="$DEV_DIR/backlog.md"
COMPLETED="$DEV_DIR/completed.md"
FAILED="$DEV_DIR/failed-tasks.md"

# Source modules
source "$REPO_ROOT/scripts/_compat.sh"

SKYNET_SCRIPTS_DIR="$REPO_ROOT/scripts"
source "$REPO_ROOT/scripts/_notify.sh"

db_add_event() { :; }
source "$REPO_ROOT/scripts/_events.sh"

source "$REPO_ROOT/scripts/_lock_backend.sh"
source "$REPO_ROOT/scripts/_locks.sh"
source "$REPO_ROOT/scripts/_db.sh"
source "$REPO_ROOT/scripts/_merge.sh"
source "$REPO_ROOT/scripts/agents/echo.sh"

unset -f db_add_event 2>/dev/null || true
source "$REPO_ROOT/scripts/_events.sh"

db_init >/dev/null 2>&1

SEP=$'\x1f'

LOG="$TMPDIR_ROOT/test-watchdog.log"
: > "$LOG"
log() { echo "[$(date '+%H:%M:%S')] $*" >> "$LOG"; }

# Stub tg (telegram notifications)
tg() { :; }

# Stub emit_event
emit_event() { :; }

# Worktree setup
WORKTREE_BASE="$TMPDIR_ROOT/worktrees"
mkdir -p "$WORKTREE_BASE"

WORKTREE_DIR=""

cleanup_worktree() {
  local delete_branch="${1:-}"
  cd "$PROJECT_DIR"
  if [ -n "$WORKTREE_DIR" ] && [ -d "$WORKTREE_DIR" ]; then
    git worktree remove "$WORKTREE_DIR" --force 2>/dev/null || rm -rf "$WORKTREE_DIR" 2>/dev/null || true
  fi
  git worktree prune 2>/dev/null || true
  if [ -n "$delete_branch" ]; then
    git branch -D "$delete_branch" 2>/dev/null || true
  fi
}

# Define git helpers
git_pull_with_retry() {
  git pull origin "$SKYNET_MAIN_BRANCH" 2>>"$LOG"
}

git_push_with_retry() {
  git push origin "$SKYNET_MAIN_BRANCH" 2>>"$LOG"
}

# run_merge wrapper (restores set +e after do_merge_to_main)
run_merge() {
  local _rm_rc=0
  _MERGE_STATE_COMMIT_FN=""
  do_merge_to_main "$@" >>"$LOG" || _rm_rc=$?
  set +e
  return $_rm_rc
}

# PID helpers
_LIVE_BG_PID=""

_start_live_bg() {
  if [ -z "$_LIVE_BG_PID" ] || ! kill -0 "$_LIVE_BG_PID" 2>/dev/null; then
    sleep 86400 &
    _LIVE_BG_PID=$!
  fi
}

_find_dead_pid() {
  local candidate=99999
  while kill -0 "$candidate" 2>/dev/null; do
    candidate=$((candidate - 1))
  done
  echo "$candidate"
}

# is_running — matches watchdog.sh
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

# MERGE_LOCK path for merge lock cleanup test
MERGE_LOCK="${SKYNET_LOCK_PREFIX}-merge.lock"

pass "Setup: isolated environment created"

# ============================================================
# TEST 1: Worker crash → stale lock cleanup → orphan task recovery
# ============================================================

echo ""
_tlog "=== Test 1: Worker crash → stale lock + orphan task recovery ==="

# Seed and claim a task (simulating worker 1 starting work)
T1_ID=$(db_add_task "Crash recovery feature A" "FEAT" "Feature A" "top")
CLAIM1=$(db_claim_next_task 1)
CLAIM1_ID=$(echo "$CLAIM1" | cut -d"$SEP" -f1)
CLAIM1_TITLE=$(echo "$CLAIM1" | cut -d"$SEP" -f2)
assert_eq "$CLAIM1_TITLE" "Crash recovery feature A" "crash: correct task claimed"

# Set worker status to in_progress
db_set_worker_status 1 "dev" "in_progress" "$CLAIM1_ID" "Crash recovery feature A" "dev/crash-feature-a" 2>/dev/null || true

# Create a lock dir with a dead PID (simulating a crashed worker)
LOCK_W1="${SKYNET_LOCK_PREFIX}-dev-worker-1.lock"
mkdir -p "$LOCK_W1"
DEAD_PID=$(_find_dead_pid)
echo "$DEAD_PID" > "$LOCK_W1/pid"

# Create a current-task file showing in_progress
TASK_FILE="$DEV_DIR/current-task-1.md"
cat > "$TASK_FILE" <<EOF
# Current Task
## Crash recovery feature A
**Status:** in_progress
**Branch:** dev/crash-feature-a
EOF

# Verify: lock exists, task is claimed
[ -d "$LOCK_W1" ] && pass "crash: stale lock dir exists before recovery" || fail "crash: lock dir should exist"
STATUS=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$CLAIM1_ID;")
assert_eq "$STATUS" "claimed" "crash: task is claimed before recovery"

# --- Phase 1: Stale lock detection and removal ---
# Replicate watchdog's phase 1 logic for this lock
if ! kill -0 "$DEAD_PID" 2>/dev/null; then
  rm -rf "$LOCK_W1"
fi

[ ! -d "$LOCK_W1" ] && pass "crash: phase 1 removed stale lock" || fail "crash: stale lock should be removed"

# --- Phase 2: Orphaned task recovery ---
# Worker is dead (lock gone), current-task shows in_progress
# Replicate watchdog's phase 2 logic
if [ -f "$TASK_FILE" ] && grep -q "in_progress" "$TASK_FILE"; then
  stuck_title=$(grep "^##" "$TASK_FILE" 2>/dev/null | head -1 | sed 's/^## //')
  if [ -n "$stuck_title" ]; then
    db_unclaim_task_by_title "$stuck_title" 2>/dev/null || true
    db_set_worker_idle 1 "dead worker recovered by watchdog" 2>/dev/null || true
    cat > "$TASK_FILE" <<IDLE_EOF
# Current Task
**Status:** idle
**Last failure:** $(date '+%Y-%m-%d %H:%M') -- ${stuck_title} (dead worker recovered by watchdog)
IDLE_EOF
  fi
fi

# Verify: task unclaimed back to pending
STATUS=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$CLAIM1_ID;")
assert_eq "$STATUS" "pending" "crash: task reset to pending after recovery"

WID=$(sqlite3 "$DB_PATH" "SELECT worker_id FROM tasks WHERE id=$CLAIM1_ID;")
assert_empty "$WID" "crash: worker_id cleared"

# Verify current-task file was reset
assert_contains "$(cat "$TASK_FILE")" "idle" "crash: current-task file reset to idle"

# ============================================================
# TEST 2: Recovered task can be re-claimed and completed
# ============================================================

echo ""
_tlog "=== Test 2: Re-claim recovered task and complete it ==="

cd "$PROJECT_DIR"
git checkout "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1 || true

# Re-claim the recovered task
RECLAIM=$(db_claim_next_task 2)
RECLAIM_ID=$(echo "$RECLAIM" | cut -d"$SEP" -f1)
RECLAIM_TITLE=$(echo "$RECLAIM" | cut -d"$SEP" -f2)
assert_eq "$RECLAIM_ID" "$CLAIM1_ID" "re-claim: same task ID re-claimed"
assert_eq "$RECLAIM_TITLE" "Crash recovery feature A" "re-claim: correct title"

# Create worktree and run echo agent
BRANCH_1="dev/crash-feature-a"
WORKTREE_DIR="$WORKTREE_BASE/w2"
git worktree add "$WORKTREE_DIR" -b "$BRANCH_1" "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1

(
  cd "$WORKTREE_DIR"
  git config user.email "test@integration.test"
  git config user.name "Integration Test"
  agent_run "Crash recovery feature A" "$LOG"
)
AGENT_RC=$?
assert_eq "$AGENT_RC" "0" "re-claim: echo agent succeeded"

# Merge to main
_merge_rc=0
run_merge "$BRANCH_1" "$WORKTREE_DIR" "$LOG" "false" || _merge_rc=$?
assert_eq "$_merge_rc" "0" "re-claim: merge succeeded"

# Complete
db_complete_task "$RECLAIM_ID" "$BRANCH_1" "1m" 60 "success" 2>/dev/null || true
STATUS=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$RECLAIM_ID;")
assert_eq "$STATUS" "completed" "re-claim: task completed after recovery and re-process"

cd "$PROJECT_DIR"
git checkout "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1 || true

# ============================================================
# TEST 3: SQLite orphaned-claim reconciliation (claimed >120s, no active worker)
# ============================================================

echo ""
_tlog "=== Test 3: SQLite orphaned-claim reconciliation ==="

T3_ID=$(db_add_task "Orphaned claim task" "FEAT" "" "top")
db_claim_next_task 3 >/dev/null

STATUS=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$T3_ID;")
assert_eq "$STATUS" "claimed" "orphan-sql: task is claimed"

# Simulate orphan: set claimed_at to >120s ago
sqlite3 "$DB_PATH" "UPDATE tasks SET claimed_at = datetime('now', '-200 seconds') WHERE id=$T3_ID;"

# Run the exact reconciliation query from watchdog.sh
_ORPHAN_CUTOFF=120
_orphaned_claimed=$(sqlite3 -separator "$SEP" "$DB_PATH" "
  SELECT t.id, t.title, t.worker_id
  FROM tasks t
  WHERE t.status = 'claimed' AND t.worker_id IS NOT NULL
    AND t.claimed_at < datetime('now', '-$_ORPHAN_CUTOFF seconds')
    AND NOT EXISTS (
      SELECT 1 FROM workers w
      WHERE w.id = t.worker_id AND w.status = 'in_progress' AND w.current_task_id = t.id
    );
" 2>/dev/null || true)

assert_not_empty "$_orphaned_claimed" "orphan-sql: detected by reconciliation query"

# Unclaim (simulate watchdog's recovery action)
while IFS="$SEP" read -r _oc_id _oc_title _oc_wid; do
  [ -z "$_oc_id" ] && continue
  db_unclaim_task "$_oc_id" 2>/dev/null || true
done <<< "$_orphaned_claimed"

STATUS=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$T3_ID;")
assert_eq "$STATUS" "pending" "orphan-sql: task reset to pending"

# Guard: fresh claim (<120s) should NOT be detected as orphaned
T3B_ID=$(db_add_task "Fresh claim guard" "FEAT" "" "top")
db_claim_next_task 1 >/dev/null
FRESH_ORPHAN=$(sqlite3 "$DB_PATH" "
  SELECT t.id FROM tasks t
  WHERE t.status = 'claimed' AND t.worker_id IS NOT NULL
    AND t.claimed_at < datetime('now', '-120 seconds')
    AND NOT EXISTS (
      SELECT 1 FROM workers w
      WHERE w.id = t.worker_id AND w.status = 'in_progress' AND w.current_task_id = t.id
    );
" 2>/dev/null || true)
assert_empty "$FRESH_ORPHAN" "orphan-sql: fresh claim not detected as orphaned"

# Clean up: unclaim fresh guard task
db_unclaim_task "$T3B_ID" 2>/dev/null || true

# ============================================================
# TEST 4: Stale fixing-N recovery (fixer crash → reset to failed)
# ============================================================

echo ""
_tlog "=== Test 4: Stale fixing-N recovery ==="

T4_ID=$(db_add_task "Fixer crash task" "FIX" "typecheck error" "top")
sqlite3 "$DB_PATH" "UPDATE tasks SET status='failed' WHERE id=$T4_ID;"
db_claim_failure "$T4_ID" 1

STATUS=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$T4_ID;")
assert_eq "$STATUS" "fixing-1" "fixing: task in fixing-1 status"

# Simulate stale: set updated_at to >120s ago, no fixer lock
sqlite3 "$DB_PATH" "UPDATE tasks SET updated_at = datetime('now', '-200 seconds') WHERE id=$T4_ID;"

FIXER_LOCK="${SKYNET_LOCK_PREFIX}-task-fixer.lock"
rm -rf "$FIXER_LOCK" 2>/dev/null || true

# Run the exact stale-fixing reconciliation from watchdog.sh
_stale_fixing=$(sqlite3 -separator "$SEP" "$DB_PATH" "
  SELECT id, title, fixer_id
  FROM tasks
  WHERE status LIKE 'fixing-%'
    AND updated_at < datetime('now', '-120 seconds');
" 2>/dev/null || true)

assert_not_empty "$_stale_fixing" "fixing: stale task detected"

while IFS="$SEP" read -r _sf_id _sf_title _sf_fid; do
  [ -z "$_sf_id" ] && continue
  _sf_fid="${_sf_fid:-1}"
  if [ "$_sf_fid" = "1" ]; then
    _sf_lock="${SKYNET_LOCK_PREFIX}-task-fixer.lock"
  else
    _sf_lock="${SKYNET_LOCK_PREFIX}-task-fixer-${_sf_fid}.lock"
  fi
  if is_running "$_sf_lock"; then
    continue
  fi
  _sf_int_id=$(_sql_int "$_sf_id")
  sqlite3 "$DB_PATH" "
    UPDATE tasks SET status='failed', fixer_id=NULL, updated_at=datetime('now')
    WHERE id=$_sf_int_id AND status LIKE 'fixing-%';
  "
done <<< "$_stale_fixing"

STATUS=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$T4_ID;")
assert_eq "$STATUS" "failed" "fixing: stale task reset to failed"

FIXER_ID=$(sqlite3 "$DB_PATH" "SELECT fixer_id FROM tasks WHERE id=$T4_ID;")
assert_empty "$FIXER_ID" "fixing: fixer_id cleared"

# Guard: live fixer should NOT trigger reconciliation
T4B_ID=$(db_add_task "Active fixer task" "FIX" "" "top")
sqlite3 "$DB_PATH" "UPDATE tasks SET status='failed' WHERE id=$T4B_ID;"
db_claim_failure "$T4B_ID" 2
sqlite3 "$DB_PATH" "UPDATE tasks SET updated_at = datetime('now', '-200 seconds') WHERE id=$T4B_ID;"

# Create a live fixer lock
FIXER_LOCK2="${SKYNET_LOCK_PREFIX}-task-fixer-2.lock"
mkdir -p "$FIXER_LOCK2"
_start_live_bg
echo "$_LIVE_BG_PID" > "$FIXER_LOCK2/pid"

if is_running "$FIXER_LOCK2"; then
  pass "fixing: live fixer detected — should not reconcile"
else
  fail "fixing: live fixer should be detected"
fi

STATUS=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$T4B_ID;")
assert_eq "$STATUS" "fixing-2" "fixing: live fixer task not reconciled"

rm -rf "$FIXER_LOCK2"

# ============================================================
# TEST 5: Orphan worktree cleanup
# ============================================================

echo ""
_tlog "=== Test 5: Orphan worktree cleanup ==="

cd "$PROJECT_DIR"
git checkout "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1 || true

# Create a worktree as if worker 3 was using it
WT_DIR="$WORKTREE_BASE/w3"
BRANCH_WT="dev/orphan-worktree-test"
git worktree add "$WT_DIR" -b "$BRANCH_WT" "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1
[ -d "$WT_DIR" ] && pass "orphan-wt: worktree created" || fail "orphan-wt: worktree should exist"

# No lock for worker 3 — worktree is orphaned
LOCK_W3="${SKYNET_LOCK_PREFIX}-dev-worker-3.lock"
rm -rf "$LOCK_W3" 2>/dev/null || true

# Verify no lock
if is_running "$LOCK_W3"; then
  fail "orphan-wt: worker 3 should not be running"
else
  pass "orphan-wt: worker 3 confirmed dead"
fi

# Phase 3 logic: remove orphan worktree
cd "$PROJECT_DIR"
git worktree remove "$WT_DIR" --force 2>/dev/null || rm -rf "$WT_DIR" 2>/dev/null || true
git worktree prune 2>/dev/null || true

[ ! -d "$WT_DIR" ] && pass "orphan-wt: worktree cleaned up" || fail "orphan-wt: worktree should be removed"

# Clean up the branch
git branch -D "$BRANCH_WT" 2>/dev/null || true

# ============================================================
# TEST 6: Merge lock cleanup (dead PID → proactive removal)
# ============================================================

echo ""
_tlog "=== Test 6: Merge lock cleanup with TOCTOU double-read ==="

# Case A: merge lock with dead PID (watchdog's double-read pattern)
mkdir -p "$MERGE_LOCK"
DEAD_ML_PID=$(_find_dead_pid)
echo "$DEAD_ML_PID" > "$MERGE_LOCK/pid"

_ml_pid_first=$(cat "$MERGE_LOCK/pid" 2>/dev/null || echo "")
if ! kill -0 "$_ml_pid_first" 2>/dev/null; then
  # TOCTOU: re-read
  _ml_pid_second=$(cat "$MERGE_LOCK/pid" 2>/dev/null || echo "")
  if [ "$_ml_pid_second" = "$_ml_pid_first" ] && ! kill -0 "$_ml_pid_first" 2>/dev/null; then
    rm -rf "$MERGE_LOCK" 2>/dev/null || true
  fi
fi

[ ! -d "$MERGE_LOCK" ] && pass "merge-lock: dead PID lock removed via double-read" || fail "merge-lock: should be removed"

# Case B: merge lock with no PID file (crash between mkdir and PID write)
mkdir -p "$MERGE_LOCK"
_ml_pid_first=""
[ -f "$MERGE_LOCK/pid" ] && _ml_pid_first=$(cat "$MERGE_LOCK/pid" 2>/dev/null || echo "")
if [ -z "$_ml_pid_first" ]; then
  _ml_pid_second=""
  [ -f "$MERGE_LOCK/pid" ] && _ml_pid_second=$(cat "$MERGE_LOCK/pid" 2>/dev/null || echo "")
  if [ -z "$_ml_pid_second" ]; then
    rm -rf "$MERGE_LOCK" 2>/dev/null || true
  fi
fi

[ ! -d "$MERGE_LOCK" ] && pass "merge-lock: no-PID lock removed" || fail "merge-lock: no-PID lock should be removed"

# Case C: merge lock with live PID — should NOT be removed
mkdir -p "$MERGE_LOCK"
_start_live_bg
echo "$_LIVE_BG_PID" > "$MERGE_LOCK/pid"

_ml_pid_first=$(cat "$MERGE_LOCK/pid" 2>/dev/null || echo "")
if kill -0 "$_ml_pid_first" 2>/dev/null; then
  pass "merge-lock: live PID holder preserved"
  [ -d "$MERGE_LOCK" ] && pass "merge-lock: lock dir intact for live holder" || fail "merge-lock: should be intact"
else
  fail "merge-lock: PID should be alive"
fi
rm -rf "$MERGE_LOCK"

# ============================================================
# TEST 7: Full end-to-end crash and recovery cycle
# ============================================================

echo ""
_tlog "=== Test 7: Full crash → recover → complete cycle ==="

cd "$PROJECT_DIR"
git checkout "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1 || true

# Mark remaining pending tasks as done to avoid interference
sqlite3 "$DB_PATH" "UPDATE tasks SET status='done' WHERE status IN ('pending','claimed');"

# Step 1: Add and claim a task, start work normally
T7_ID=$(db_add_task "Full cycle crash test" "FEAT" "End-to-end test" "top")
CLAIM7=$(db_claim_next_task 1)
CLAIM7_ID=$(echo "$CLAIM7" | cut -d"$SEP" -f1)
CLAIM7_TITLE=$(echo "$CLAIM7" | cut -d"$SEP" -f2)
assert_eq "$CLAIM7_TITLE" "Full cycle crash test" "full-cycle: task claimed"

db_set_worker_status 1 "dev" "in_progress" "$CLAIM7_ID" "Full cycle crash test" "dev/full-cycle-crash" 2>/dev/null || true

# Step 2: Create worktree and simulate partial work
BRANCH_7="dev/full-cycle-crash"
WORKTREE_DIR="$WORKTREE_BASE/w1"
cleanup_worktree 2>/dev/null || true
git worktree add "$WORKTREE_DIR" -b "$BRANCH_7" "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1

(
  cd "$WORKTREE_DIR"
  git config user.email "test@integration.test"
  git config user.name "Integration Test"
  echo "partial work" > partial.txt
  git add partial.txt
  git commit -m "partial work before crash" >/dev/null 2>&1
)

# Step 3: Simulate crash — create stale lock, stale task file
LOCK_W1="${SKYNET_LOCK_PREFIX}-dev-worker-1.lock"
mkdir -p "$LOCK_W1"
DEAD_PID=$(_find_dead_pid)
echo "$DEAD_PID" > "$LOCK_W1/pid"

TASK_FILE="$DEV_DIR/current-task-1.md"
cat > "$TASK_FILE" <<EOF
# Current Task
## Full cycle crash test
**Status:** in_progress
**Branch:** dev/full-cycle-crash
EOF

# Verify crash state
[ -d "$LOCK_W1" ] && pass "full-cycle: stale lock set up" || fail "full-cycle: stale lock should exist"
STATUS=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$CLAIM7_ID;")
assert_eq "$STATUS" "claimed" "full-cycle: task still claimed (pre-recovery)"

# Step 4: Run crash recovery (all 3 phases)

# Phase 1: stale lock cleanup
if ! kill -0 "$DEAD_PID" 2>/dev/null; then
  rm -rf "$LOCK_W1"
fi
[ ! -d "$LOCK_W1" ] && pass "full-cycle: phase 1 cleaned stale lock" || fail "full-cycle: stale lock should be removed"

# Phase 2: orphaned task recovery (file-based)
if [ -f "$TASK_FILE" ] && grep -q "in_progress" "$TASK_FILE"; then
  stuck_title=$(grep "^##" "$TASK_FILE" 2>/dev/null | head -1 | sed 's/^## //')
  if [ -n "$stuck_title" ]; then
    db_unclaim_task_by_title "$stuck_title" 2>/dev/null || true
    db_set_worker_idle 1 "dead worker recovered by watchdog" 2>/dev/null || true
    cat > "$TASK_FILE" <<IDLE_EOF
# Current Task
**Status:** idle
**Last failure:** $(date '+%Y-%m-%d %H:%M') -- ${stuck_title} (dead worker recovered by watchdog)
IDLE_EOF
  fi
fi

STATUS=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$CLAIM7_ID;")
assert_eq "$STATUS" "pending" "full-cycle: phase 2 unclaimed orphaned task"

# Phase 3: orphan worktree cleanup (worker 1 lock is gone, w1 worktree exists)
if [ -d "$WORKTREE_DIR" ] && ! is_running "$LOCK_W1"; then
  cd "$PROJECT_DIR"
  git worktree remove "$WORKTREE_DIR" --force 2>/dev/null || rm -rf "$WORKTREE_DIR" 2>/dev/null || true
  git worktree prune 2>/dev/null || true
fi
[ ! -d "$WORKTREE_DIR" ] && pass "full-cycle: phase 3 cleaned orphan worktree" || fail "full-cycle: worktree should be removed"
git branch -D "$BRANCH_7" 2>/dev/null || true

# Step 5: Re-claim the recovered task and complete it
cd "$PROJECT_DIR"
git checkout "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1 || true

RECLAIM7=$(db_claim_next_task 2)
RECLAIM7_ID=$(echo "$RECLAIM7" | cut -d"$SEP" -f1)
RECLAIM7_TITLE=$(echo "$RECLAIM7" | cut -d"$SEP" -f2)
assert_eq "$RECLAIM7_ID" "$CLAIM7_ID" "full-cycle: same task re-claimed after recovery"

BRANCH_7B="dev/full-cycle-crash-retry"
WORKTREE_DIR="$WORKTREE_BASE/w2"
cleanup_worktree 2>/dev/null || true
git worktree add "$WORKTREE_DIR" -b "$BRANCH_7B" "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1

(
  cd "$WORKTREE_DIR"
  git config user.email "test@integration.test"
  git config user.name "Integration Test"
  agent_run "Full cycle crash test" "$LOG"
)
AGENT_RC=$?
assert_eq "$AGENT_RC" "0" "full-cycle: echo agent succeeded on retry"

_merge_rc=0
run_merge "$BRANCH_7B" "$WORKTREE_DIR" "$LOG" "false" || _merge_rc=$?
assert_eq "$_merge_rc" "0" "full-cycle: merge succeeded on retry"

db_complete_task "$RECLAIM7_ID" "$BRANCH_7B" "2m" 120 "success" 2>/dev/null || true
STATUS=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$RECLAIM7_ID;")
assert_eq "$STATUS" "completed" "full-cycle: task completed after crash recovery"

cd "$PROJECT_DIR"
git checkout "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1 || true

# Verify the echo agent file is on main
MAIN_FILE=$(ls echo-agent-*.md 2>/dev/null | head -1)
assert_not_empty "$MAIN_FILE" "full-cycle: echo agent output on main after recovery"

# ============================================================
# TEST 8: Backlog marker sync after recovery
# ============================================================

echo ""
_tlog "=== Test 8: Backlog marker sync ==="

# Mark remaining tasks done
sqlite3 "$DB_PATH" "UPDATE tasks SET status='done' WHERE status IN ('pending','claimed','fixing-1','fixing-2');"

# Add tasks and claim one
T8A_ID=$(db_add_task "Backlog sync alpha" "FEAT" "" "top")
T8B_ID=$(db_add_task "Backlog sync beta" "FEAT" "" "bottom")

# Export backlog
db_export_state_files

BACKLOG_CONTENT=$(cat "$BACKLOG" 2>/dev/null || echo "")
assert_contains "$BACKLOG_CONTENT" "Backlog sync alpha" "backlog-sync: alpha in backlog"
assert_contains "$BACKLOG_CONTENT" "Backlog sync beta" "backlog-sync: beta in backlog"

# Claim alpha
db_claim_next_task 1 >/dev/null

# Export again (alpha should now show [>])
db_export_state_files

BACKLOG_AFTER=$(cat "$BACKLOG" 2>/dev/null || echo "")
CLAIMED_COUNT=$(grep -c '^\- \[>\]' "$BACKLOG" 2>/dev/null || echo "0")
PENDING_COUNT=$(grep -c '^\- \[ \]' "$BACKLOG" 2>/dev/null || echo "0")

# Simulate crash: unclaim via DB but don't update backlog
db_unclaim_task "$T8A_ID" 2>/dev/null || true

# DB says 2 pending, 0 claimed — but backlog may still show 1 [>], 1 [ ]
DB_PENDING=$(_db "SELECT COUNT(*) FROM tasks WHERE status='pending';" 2>/dev/null || echo "0")
assert_eq "$DB_PENDING" "2" "backlog-sync: DB shows 2 pending after unclaim"

# Run backlog marker sync (watchdog logic)
db_export_backlog "$BACKLOG" 2>/dev/null || true

# Verify sync: backlog should now match DB (2 pending, 0 claimed)
SYNC_PENDING=$(grep -c '^\- \[ \]' "$BACKLOG" 2>/dev/null) || true
SYNC_CLAIMED=$(grep -c '^\- \[>\]' "$BACKLOG" 2>/dev/null) || true

assert_eq "$SYNC_PENDING" "2" "backlog-sync: backlog shows 2 pending after sync"
assert_eq "$SYNC_CLAIMED" "0" "backlog-sync: backlog shows 0 claimed after sync"

# ============================================================
# TEST 9: Multiple simultaneous worker crashes
# ============================================================

echo ""
_tlog "=== Test 9: Multiple simultaneous worker crashes ==="

# Mark all as done
sqlite3 "$DB_PATH" "UPDATE tasks SET status='done' WHERE status NOT IN ('completed','fixed','done','blocked','superseded');"

# Add 3 tasks and claim each with different workers
T9A_ID=$(db_add_task "Multi-crash A" "FEAT" "" "top")
T9B_ID=$(db_add_task "Multi-crash B" "FEAT" "" "top")
T9C_ID=$(db_add_task "Multi-crash C" "FEAT" "" "top")

db_claim_next_task 1 >/dev/null
db_claim_next_task 2 >/dev/null
db_claim_next_task 3 >/dev/null

# All three should be claimed
STATUS_A=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$T9A_ID;")
STATUS_B=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$T9B_ID;")
STATUS_C=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$T9C_ID;")
assert_eq "$STATUS_A" "claimed" "multi-crash: task A claimed"
assert_eq "$STATUS_B" "claimed" "multi-crash: task B claimed"
assert_eq "$STATUS_C" "claimed" "multi-crash: task C claimed"

# Simulate all 3 workers crashing: backdate claimed_at for orphan detection
sqlite3 "$DB_PATH" "UPDATE tasks SET claimed_at = datetime('now', '-200 seconds') WHERE id IN ($T9A_ID, $T9B_ID, $T9C_ID);"

# Run reconciliation
_orphaned=$(sqlite3 -separator "$SEP" "$DB_PATH" "
  SELECT t.id, t.title, t.worker_id
  FROM tasks t
  WHERE t.status = 'claimed' AND t.worker_id IS NOT NULL
    AND t.claimed_at < datetime('now', '-120 seconds')
    AND NOT EXISTS (
      SELECT 1 FROM workers w
      WHERE w.id = t.worker_id AND w.status = 'in_progress' AND w.current_task_id = t.id
    );
" 2>/dev/null || true)

ORPHAN_COUNT=$(echo "$_orphaned" | grep -c . || echo "0")
assert_eq "$ORPHAN_COUNT" "3" "multi-crash: all 3 orphaned tasks detected"

# Recover all
while IFS="$SEP" read -r _oc_id _oc_title _oc_wid; do
  [ -z "$_oc_id" ] && continue
  db_unclaim_task "$_oc_id" 2>/dev/null || true
done <<< "$_orphaned"

STATUS_A=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$T9A_ID;")
STATUS_B=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$T9B_ID;")
STATUS_C=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$T9C_ID;")
assert_eq "$STATUS_A" "pending" "multi-crash: task A recovered to pending"
assert_eq "$STATUS_B" "pending" "multi-crash: task B recovered to pending"
assert_eq "$STATUS_C" "pending" "multi-crash: task C recovered to pending"

# Verify all 3 can be re-claimed
for wid in 1 2 3; do
  _reclaim=$(db_claim_next_task "$wid")
  assert_not_empty "$_reclaim" "multi-crash: worker $wid re-claimed a task"
done

# ============================================================
# TEST 10: Database state consistency after all tests
# ============================================================

echo ""
_tlog "=== Test 10: Database state consistency ==="

TOTAL_COMPLETED=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM tasks WHERE status='completed';")
TOTAL_CLAIMED=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM tasks WHERE status='claimed';")

# We completed: feature A (test 2) + full cycle crash test (test 7) = 2
assert_eq "$TOTAL_COMPLETED" "2" "db state: 2 total completed tasks"

# 3 tasks were re-claimed in test 9
assert_eq "$TOTAL_CLAIMED" "3" "db state: 3 tasks currently claimed (test 9 re-claims)"

# No tasks stuck in fixing with dead fixer
STUCK_FIXING=$(sqlite3 "$DB_PATH" "
  SELECT COUNT(*) FROM tasks
  WHERE status LIKE 'fixing-%'
    AND updated_at < datetime('now', '-120 seconds');
")
assert_eq "$STUCK_FIXING" "0" "db state: no stale fixing tasks"

# ── Summary ──────────────────────────────────────────────────────

echo ""
TOTAL=$((PASS + FAIL))
_tlog "Results: $PASS/$TOTAL passed, $FAIL failed"
if [ $FAIL -eq 0 ]; then
  printf "  \033[32mAll checks passed!\033[0m\n"
else
  printf "  \033[31mSome checks failed!\033[0m\n"
  exit 1
fi
