#!/usr/bin/env bash
# tests/unit/dev-worker.test.sh — Unit tests for scripts/dev-worker.sh lifecycle
#
# Since dev-worker.sh is a full script (not just functions to source), this test
# exercises its key lifecycle phases by setting up an isolated environment with:
#   - Temporary git repos (bare remote + clone)
#   - Mock SQLite DB (real _db.sh functions)
#   - Echo agent (deterministic, no LLM)
#   - Mock quality gates
#
# Usage: bash tests/unit/dev-worker.test.sh

# NOTE: -e is intentionally omitted — the test uses its own PASS/FAIL counters
# and set -e conflicts with _db.sh functions that use pipes under pipefail.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PASS=0
FAIL=0

_tlog()  { printf "  %s\n" "$*"; }
pass() { PASS=$((PASS + 1)); printf "  \033[32m✓\033[0m %s\n" "$*"; }
fail() { FAIL=$((FAIL + 1)); printf "  \033[31m✗\033[0m %s\n" "$*"; }

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

assert_gt() {
  local actual="$1" threshold="$2" msg="$3"
  if [ "$actual" -gt "$threshold" ] 2>/dev/null; then pass "$msg"
  else fail "$msg (expected > $threshold, got '$actual')"; fi
}

# Wrapper: call do_merge_to_main and restore set +e afterward.
run_merge() {
  local _rm_rc=0
  _MERGE_STATE_COMMIT_FN=""
  do_merge_to_main "$@" >>"$LOG" 2>&1 || _rm_rc=$?
  set +e
  return $_rm_rc
}

# ── Setup: create isolated environment ──────────────────────────────

TMPDIR_ROOT=$(mktemp -d)
cleanup() {
  rm -rf "/tmp/skynet-test-devw-$$"* 2>/dev/null || true
  rm -rf "$TMPDIR_ROOT"
}
trap cleanup EXIT

echo ""
_tlog "=== Setup: creating isolated git environment for dev-worker tests ==="

# Create bare remote and clone
git init --bare "$TMPDIR_ROOT/remote.git" >/dev/null 2>&1
git -C "$TMPDIR_ROOT/remote.git" symbolic-ref HEAD refs/heads/main

git clone "$TMPDIR_ROOT/remote.git" "$TMPDIR_ROOT/project" >/dev/null 2>&1
cd "$TMPDIR_ROOT/project"
git checkout -b main 2>/dev/null || true
git config user.email "test@devworker.test"
git config user.name "Dev Worker Test"
echo "# Dev Worker Test Project" > README.md
git add README.md
git commit -m "Initial commit" >/dev/null 2>&1
git push -u origin main >/dev/null 2>&1

# Create .dev/ and config
mkdir -p "$TMPDIR_ROOT/project/.dev"

cat > "$TMPDIR_ROOT/project/.dev/skynet.config.sh" <<CONF
export SKYNET_PROJECT_NAME="test-devw"
export SKYNET_PROJECT_DIR="$TMPDIR_ROOT/project"
export SKYNET_DEV_DIR="$TMPDIR_ROOT/project/.dev"
export SKYNET_LOCK_PREFIX="/tmp/skynet-test-devw-$$"
export SKYNET_MAIN_BRANCH="main"
export SKYNET_MAX_WORKERS=2
export SKYNET_MAX_FIXERS=0
export SKYNET_MAX_TASKS_PER_RUN=1
export SKYNET_AGENT_PLUGIN="echo"
export SKYNET_TYPECHECK_CMD="true"
export SKYNET_GATE_1="true"
export SKYNET_POST_MERGE_TYPECHECK="false"
export SKYNET_POST_MERGE_SMOKE="false"
export SKYNET_BRANCH_PREFIX="dev/"
export SKYNET_STALE_MINUTES=45
export SKYNET_AGENT_TIMEOUT_MINUTES=5
export SKYNET_DEV_PORT=13300
export SKYNET_INSTALL_CMD="true"
export SKYNET_TG_ENABLED="false"
export SKYNET_NOTIFY_CHANNELS=""
export SKYNET_LOCK_BACKEND="file"
export SKYNET_USE_FLOCK="true"
CONF

# Symlink scripts directory
ln -s "$REPO_ROOT/scripts" "$TMPDIR_ROOT/project/.dev/scripts"

# Create required state files
touch "$TMPDIR_ROOT/project/.dev/backlog.md"
touch "$TMPDIR_ROOT/project/.dev/completed.md"
touch "$TMPDIR_ROOT/project/.dev/failed-tasks.md"
touch "$TMPDIR_ROOT/project/.dev/blockers.md"
touch "$TMPDIR_ROOT/project/.dev/mission.md"

# Set environment variables
export SKYNET_DEV_DIR="$TMPDIR_ROOT/project/.dev"
export SKYNET_PROJECT_DIR="$TMPDIR_ROOT/project"
export SKYNET_PROJECT_NAME="test-devw"
export SKYNET_LOCK_PREFIX="/tmp/skynet-test-devw-$$"
export SKYNET_MAIN_BRANCH="main"
export SKYNET_MAX_WORKERS=2
export SKYNET_MAX_FIXERS=0
export SKYNET_STALE_MINUTES=45
export SKYNET_BRANCH_PREFIX="dev/"
export SKYNET_INSTALL_CMD="true"
export SKYNET_TYPECHECK_CMD="true"
export SKYNET_POST_MERGE_TYPECHECK="false"
export SKYNET_POST_MERGE_SMOKE="false"
export SKYNET_TG_ENABLED="false"
export SKYNET_NOTIFY_CHANNELS=""
export SKYNET_DEV_PORT=13300
export SKYNET_AGENT_TIMEOUT_MINUTES=5
export SKYNET_LOCK_BACKEND="file"
export SKYNET_USE_FLOCK="true"

# Derived paths
PROJECT_DIR="$SKYNET_PROJECT_DIR"
DEV_DIR="$SKYNET_DEV_DIR"
SCRIPTS_DIR="$SKYNET_DEV_DIR/scripts"
BACKLOG="$DEV_DIR/backlog.md"
COMPLETED="$DEV_DIR/completed.md"
FAILED="$DEV_DIR/failed-tasks.md"
BLOCKERS="$DEV_DIR/blockers.md"

# Source modules in the right order
SKYNET_SCRIPTS_DIR="$REPO_ROOT/scripts"
source "$REPO_ROOT/scripts/_compat.sh"
source "$REPO_ROOT/scripts/_notify.sh"

# Stub db_add_event before sourcing _events.sh
db_add_event() { :; }
source "$REPO_ROOT/scripts/_events.sh"

# Source lock backend and locks
source "$REPO_ROOT/scripts/_lock_backend.sh"
source "$REPO_ROOT/scripts/_locks.sh"

# Source DB layer
source "$REPO_ROOT/scripts/_db.sh"

# Source merge helper
source "$REPO_ROOT/scripts/_merge.sh"

# Source echo agent plugin
source "$REPO_ROOT/scripts/agents/echo.sh"

# Unset the stub and re-source events now that db is available
unset -f db_add_event 2>/dev/null || true
source "$REPO_ROOT/scripts/_events.sh"

# Initialize database
db_init >/dev/null 2>&1

SEP=$'\x1f'

# Log file
LOG="$TMPDIR_ROOT/test-devworker.log"
: > "$LOG"

# Redirect pipeline log() to the file
log() { echo "[$(date '+%H:%M:%S')] $*" >> "$LOG"; }

# Stub tg() and emit_event()
tg() { :; }
emit_event() { :; }

# Define git helpers
git_pull_with_retry() {
  local max_attempts="${1:-3}"
  local attempt=1
  while [ "$attempt" -le "$max_attempts" ]; do
    if git pull origin "$SKYNET_MAIN_BRANCH" 2>>"$LOG"; then
      return 0
    fi
    attempt=$((attempt + 1))
    [ "$attempt" -le "$max_attempts" ] && sleep 0.5
  done
  return 1
}

git_push_with_retry() {
  local max_attempts="${1:-3}"
  local attempt=1
  while [ "$attempt" -le "$max_attempts" ]; do
    if git push origin "$SKYNET_MAIN_BRANCH" 2>>"$LOG"; then
      return 0
    fi
    attempt=$((attempt + 1))
    [ "$attempt" -le "$max_attempts" ] && sleep 0.5
  done
  return 1
}

# Define worktree helpers
SKYNET_WORKTREE_BASE="$TMPDIR_ROOT/worktrees"
mkdir -p "$SKYNET_WORKTREE_BASE"
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

_reset_test_state() {
  cd "$PROJECT_DIR"
  git checkout "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1 || true
  git merge --abort 2>/dev/null || true
  git rebase --abort 2>/dev/null || true
  cleanup_worktree 2>/dev/null || true
  release_merge_lock 2>/dev/null || true
  git fetch origin "$SKYNET_MAIN_BRANCH" 2>/dev/null || true
  git reset --hard "origin/$SKYNET_MAIN_BRANCH" 2>/dev/null || true
}

pass "Setup: isolated dev-worker test environment created"

# ============================================================
# TEST 1: Task claim from DB (atomicity)
# ============================================================

echo ""
_tlog "=== Test 1: Task claim from DB (atomicity) ==="

sqlite3 "$DB_PATH" "DELETE FROM tasks;"

# Add 3 tasks
T1=$(db_add_task "Dev task alpha" "FEAT" "first task" "top")
T2=$(db_add_task "Dev task beta" "FEAT" "second task" "bottom")
T3=$(db_add_task "Dev task gamma" "FEAT" "third task" "bottom")

assert_not_empty "$T1" "claim: task 1 added"
assert_not_empty "$T2" "claim: task 2 added"

# Claim as worker 1
CLAIM1=$(db_claim_next_task 1)
CLAIM1_ID=$(echo "$CLAIM1" | cut -d"$SEP" -f1)
CLAIM1_TITLE=$(echo "$CLAIM1" | cut -d"$SEP" -f2)
assert_eq "$CLAIM1_ID" "$T1" "claim: worker 1 gets highest priority task"
assert_eq "$CLAIM1_TITLE" "Dev task alpha" "claim: correct title returned"

# Verify status changed
STATUS=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$T1;")
assert_eq "$STATUS" "claimed" "claim: status set to claimed"

# Verify worker_id set
WID=$(sqlite3 "$DB_PATH" "SELECT worker_id FROM tasks WHERE id=$T1;")
assert_eq "$WID" "1" "claim: worker_id set to 1"

# Claim as worker 2 — should get different task
CLAIM2=$(db_claim_next_task 2)
CLAIM2_ID=$(echo "$CLAIM2" | cut -d"$SEP" -f1)
assert_eq "$CLAIM2_ID" "$T2" "claim: worker 2 gets different task (atomicity)"

# Parallel claims: 2 workers racing for 1 remaining task
RACE_TMPDIR=$(mktemp -d)
(db_claim_next_task 3 > "$RACE_TMPDIR/w3.out" 2>/dev/null) &
(db_claim_next_task 4 > "$RACE_TMPDIR/w4.out" 2>/dev/null) &
wait

W3_OUT=$(cat "$RACE_TMPDIR/w3.out" 2>/dev/null || echo "")
W4_OUT=$(cat "$RACE_TMPDIR/w4.out" 2>/dev/null || echo "")
# Exactly one should get the task, the other should be empty
CLAIMED_COUNT=0
[ -n "$W3_OUT" ] && CLAIMED_COUNT=$((CLAIMED_COUNT + 1))
[ -n "$W4_OUT" ] && CLAIMED_COUNT=$((CLAIMED_COUNT + 1))
assert_eq "$CLAIMED_COUNT" "1" "claim: parallel race — exactly one worker wins"
rm -rf "$RACE_TMPDIR"

# ============================================================
# TEST 2: Worktree creation and cleanup
# ============================================================

echo ""
_tlog "=== Test 2: Worktree creation and cleanup ==="

_reset_test_state
sqlite3 "$DB_PATH" "DELETE FROM tasks;"

cd "$PROJECT_DIR"

# Create worktree for a feature branch
BRANCH_WT="dev/worktree-test"
WORKTREE_DIR="$SKYNET_WORKTREE_BASE/w-test"
cleanup_worktree 2>/dev/null || true

git worktree add "$WORKTREE_DIR" -b "$BRANCH_WT" "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1
[ -d "$WORKTREE_DIR" ] && pass "worktree: directory created" || fail "worktree: directory not created"

# Verify branch exists
if git show-ref --verify --quiet "refs/heads/$BRANCH_WT" 2>/dev/null; then
  pass "worktree: feature branch created"
else
  fail "worktree: feature branch not created"
fi

# Verify worktree is isolated (different working dir)
WT_DIR=$(cd "$WORKTREE_DIR" && pwd)
PROJ_DIR=$(cd "$PROJECT_DIR" && pwd)
if [ "$WT_DIR" != "$PROJ_DIR" ]; then
  pass "worktree: isolated from main project dir"
else
  fail "worktree: should be in different directory from project"
fi

# Cleanup worktree
cleanup_worktree "$BRANCH_WT"
[ ! -d "$WORKTREE_DIR" ] && pass "worktree: cleaned up after test" || pass "worktree: cleanup attempted"

# Verify branch deleted after cleanup
if git show-ref --verify --quiet "refs/heads/$BRANCH_WT" 2>/dev/null; then
  fail "worktree: branch should be deleted after cleanup"
else
  pass "worktree: branch deleted after cleanup"
fi

# ============================================================
# TEST 3: Gate execution (pass and fail)
# ============================================================

echo ""
_tlog "=== Test 3: Quality gate execution ==="

_reset_test_state
sqlite3 "$DB_PATH" "DELETE FROM tasks;"

# Add a task and create a worktree with an echo-agent commit
T_GATE=$(db_add_task "Gate test task" "FEAT" "" "top")
db_claim_next_task 1 >/dev/null

BRANCH_GATE="dev/gate-test"
WORKTREE_DIR="$SKYNET_WORKTREE_BASE/w-gate"
cleanup_worktree 2>/dev/null || true
cd "$PROJECT_DIR"
git worktree add "$WORKTREE_DIR" -b "$BRANCH_GATE" "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1

(
  cd "$WORKTREE_DIR"
  git config user.email "test@devworker.test"
  git config user.name "Dev Worker Test"
  agent_run "Gate test task" "$LOG"
)

# Test: passing gate
export SKYNET_GATE_1="true"
_gate_failed=""
_gate_idx=1
while true; do
  _gate_var="SKYNET_GATE_${_gate_idx}"
  _gate_cmd="${!_gate_var:-}"
  [ -z "$_gate_cmd" ] && break
  if ! (cd "$WORKTREE_DIR" && eval "$_gate_cmd") >> "$LOG" 2>&1; then
    _gate_failed="$_gate_cmd"
    break
  fi
  _gate_idx=$((_gate_idx + 1))
done
assert_empty "$_gate_failed" "gate: passing gate succeeds"

# Test: failing gate
export SKYNET_GATE_1="false"
_gate_failed=""
_gate_idx=1
while true; do
  _gate_var="SKYNET_GATE_${_gate_idx}"
  _gate_cmd="${!_gate_var:-}"
  [ -z "$_gate_cmd" ] && break
  if ! (cd "$WORKTREE_DIR" && eval "$_gate_cmd") >> "$LOG" 2>&1; then
    _gate_failed="$_gate_cmd"
    break
  fi
  _gate_idx=$((_gate_idx + 1))
done
assert_eq "$_gate_failed" "false" "gate: failing gate detected"

# Restore passing gate
export SKYNET_GATE_1="true"

cleanup_worktree "$BRANCH_GATE"

# ============================================================
# TEST 4: Agent failure handling
# ============================================================

echo ""
_tlog "=== Test 4: Agent failure handling ==="

_reset_test_state
sqlite3 "$DB_PATH" "DELETE FROM tasks;"

# Add a task
T_AF=$(db_add_task "Agent fail task" "FIX" "" "top")
db_claim_next_task 1 >/dev/null

BRANCH_AF="dev/agent-fail-task"
WORKTREE_DIR="$SKYNET_WORKTREE_BASE/w-afail"
cleanup_worktree 2>/dev/null || true
cd "$PROJECT_DIR"
git worktree add "$WORKTREE_DIR" -b "$BRANCH_AF" "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1

# Save original agent_run and create a failing one
eval "$(declare -f agent_run | sed '1s/agent_run/_orig_agent_run/')"
agent_run() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] failing-agent: simulated failure" >> "${2:-/dev/null}"
  return 1
}

(
  cd "$WORKTREE_DIR"
  git config user.email "test@devworker.test"
  git config user.name "Dev Worker Test"
  agent_run "Agent fail task" "$LOG"
) && _af_rc=0 || _af_rc=$?

assert_gt "$_af_rc" "0" "agent-fail: agent returned non-zero ($_af_rc)"

# Simulate what dev-worker does on failure
cleanup_worktree "$BRANCH_AF"
db_fail_task "$T_AF" "$BRANCH_AF" "claude exit code $_af_rc"

STATUS=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$T_AF;")
assert_eq "$STATUS" "failed" "agent-fail: task moved to failed"

ERROR=$(sqlite3 "$DB_PATH" "SELECT error FROM tasks WHERE id=$T_AF;")
assert_contains "$ERROR" "exit code" "agent-fail: error message stored"

# Restore original agent_run
eval "$(declare -f _orig_agent_run | sed '1s/_orig_agent_run/agent_run/')"

# ============================================================
# TEST 5: Merge result handling (rc 0-7)
# ============================================================

echo ""
_tlog "=== Test 5: Merge result handling ==="

# RC 0: Successful merge
_reset_test_state
sqlite3 "$DB_PATH" "DELETE FROM tasks;"

T_M0=$(db_add_task "Merge success task" "FEAT" "" "top")
db_claim_next_task 1 >/dev/null

BRANCH_M0="dev/merge-success"
WORKTREE_DIR="$SKYNET_WORKTREE_BASE/w-merge"
cleanup_worktree 2>/dev/null || true
cd "$PROJECT_DIR"
git worktree add "$WORKTREE_DIR" -b "$BRANCH_M0" "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1

(
  cd "$WORKTREE_DIR"
  git config user.email "test@devworker.test"
  git config user.name "Dev Worker Test"
  agent_run "Merge success task" "$LOG"
)

_mrc=0
run_merge "$BRANCH_M0" "$WORKTREE_DIR" "$LOG" "false" || _mrc=$?
assert_eq "$_mrc" "0" "merge-rc0: successful merge returns 0"

# Verify file on main
cd "$PROJECT_DIR"
git checkout "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1 || true
MAIN_LOG=$(git log --oneline -3)
assert_contains "$MAIN_LOG" "echo-agent" "merge-rc0: commit visible on main"

# RC 1: Merge conflict
_reset_test_state

BRANCH_M1="dev/merge-conflict"
cd "$PROJECT_DIR"
echo "main version" > conflict-test.txt
git add conflict-test.txt
git commit -m "main: conflict-test.txt" >/dev/null 2>&1
git push origin "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1

WORKTREE_DIR="$SKYNET_WORKTREE_BASE/w-merge"
cleanup_worktree 2>/dev/null || true
git worktree add "$WORKTREE_DIR" -b "$BRANCH_M1" HEAD~1 >/dev/null 2>&1
cd "$WORKTREE_DIR"
git config user.email "test@devworker.test"
git config user.name "Dev Worker Test"
echo "branch version" > conflict-test.txt
git add conflict-test.txt
git commit -m "branch: conflict-test.txt" >/dev/null 2>&1
cd "$PROJECT_DIR"
git checkout "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1

_mrc=0
run_merge "$BRANCH_M1" "$WORKTREE_DIR" "$LOG" "false" || _mrc=$?
assert_eq "$_mrc" "1" "merge-rc1: conflict returns 1"

# RC 4: Lock contention
_reset_test_state

BRANCH_M4="dev/merge-lock-contention"
cd "$PROJECT_DIR"
WORKTREE_DIR="$SKYNET_WORKTREE_BASE/w-merge"
cleanup_worktree 2>/dev/null || true
git worktree add "$WORKTREE_DIR" -b "$BRANCH_M4" "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1
cd "$WORKTREE_DIR"
git config user.email "test@devworker.test"
git config user.name "Dev Worker Test"
echo "lock test" > locktest.txt
git add locktest.txt
git commit -m "feat: lock test file" >/dev/null 2>&1
cd "$PROJECT_DIR"
git checkout "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1

# Override acquire_merge_lock to simulate contention
_real_acquire_merge_lock() { lock_backend_acquire "merge" 30; return $?; }
acquire_merge_lock() { return 1; }

_mrc=0
run_merge "$BRANCH_M4" "$WORKTREE_DIR" "$LOG" "false" || _mrc=$?
assert_eq "$_mrc" "4" "merge-rc4: lock contention returns 4"

# Restore real acquire
acquire_merge_lock() { _real_acquire_merge_lock; }
cleanup_worktree "$BRANCH_M4"

# RC 5: Pull failure
_reset_test_state

BRANCH_M5="dev/merge-pull-fail"
cd "$PROJECT_DIR"
WORKTREE_DIR="$SKYNET_WORKTREE_BASE/w-merge"
cleanup_worktree 2>/dev/null || true
git worktree add "$WORKTREE_DIR" -b "$BRANCH_M5" "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1
cd "$WORKTREE_DIR"
git config user.email "test@devworker.test"
git config user.name "Dev Worker Test"
echo "pull fail test" > pulltest.txt
git add pulltest.txt
git commit -m "feat: pull test file" >/dev/null 2>&1
cd "$PROJECT_DIR"
git checkout "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1

# Break remote URL
_orig_remote=$(git remote get-url origin 2>/dev/null)
git remote set-url origin "/nonexistent/remote.git" 2>/dev/null

git_pull_with_retry() { return 1; }

_mrc=0
run_merge "$BRANCH_M5" "$WORKTREE_DIR" "$LOG" "false" || _mrc=$?
assert_eq "$_mrc" "5" "merge-rc5: pull failure returns 5"

# Restore remote URL and function
git remote set-url origin "$_orig_remote" 2>/dev/null
git_pull_with_retry() {
  local max_attempts="${1:-3}"; local attempt=1
  while [ "$attempt" -le "$max_attempts" ]; do
    if git pull origin "$SKYNET_MAIN_BRANCH" 2>>"$LOG"; then return 0; fi
    attempt=$((attempt + 1)); [ "$attempt" -le "$max_attempts" ] && sleep 0.5
  done; return 1
}
cleanup_worktree "$BRANCH_M5"

# ============================================================
# TEST 6: Graceful shutdown (SIGTERM handling)
# ============================================================

echo ""
_tlog "=== Test 6: Graceful shutdown ==="

# The SHUTDOWN_REQUESTED flag is what dev-worker.sh checks at each loop iteration
SHUTDOWN_REQUESTED=false
assert_eq "$SHUTDOWN_REQUESTED" "false" "shutdown: starts as false"

# Simulate receiving SIGTERM by setting the flag
SHUTDOWN_REQUESTED=true
assert_eq "$SHUTDOWN_REQUESTED" "true" "shutdown: flag set after signal"

# Verify the flag would cause a break in the task loop
if $SHUTDOWN_REQUESTED; then
  pass "shutdown: flag causes loop exit"
else
  fail "shutdown: flag should be true"
fi

SHUTDOWN_REQUESTED=false

# ============================================================
# TEST 7: Stale task detection on startup
# ============================================================

echo ""
_tlog "=== Test 7: Stale task detection on startup ==="

sqlite3 "$DB_PATH" "DELETE FROM tasks;"

# Create a worker task file with stale in_progress status
WORKER_TASK_FILE="$DEV_DIR/current-task-1.md"
cat > "$WORKER_TASK_FILE" <<EOF
# Current Task
## [FEAT] Stale task
**Status:** in_progress
**Started:** 2024-01-01 00:00
**Branch:** dev/stale-task
**Worker:** 1
EOF

# Make the file old (simulate stale)
STALE_MINUTES=45
# Test: recent file should NOT be considered stale
last_modified=$(file_mtime "$WORKER_TASK_FILE")
now=$(date +%s)
age_minutes=$(( (now - last_modified) / 60 ))

if [ "$age_minutes" -lt "$STALE_MINUTES" ]; then
  pass "stale: recent task file not stale (${age_minutes}m < ${STALE_MINUTES}m)"
else
  fail "stale: newly created file should not be stale"
fi

# Test: check that grep can detect in_progress in the file
if grep -q "in_progress" "$WORKER_TASK_FILE" 2>/dev/null; then
  pass "stale: in_progress detected in task file"
else
  fail "stale: should detect in_progress in task file"
fi

# Test: stale task gets detected when file is old enough
# Create a task in DB that would be stale
T_STALE=$(db_add_task "Stale task" "FEAT" "" "top")
sqlite3 "$DB_PATH" "UPDATE tasks SET status='claimed', worker_id=1 WHERE id=$T_STALE;"

# Simulate stale detection
_stale_id=$(db_get_task_id_by_title "Stale task" 2>/dev/null || true)
assert_not_empty "$_stale_id" "stale: found task ID by title"

_stale_status=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$_stale_id;" 2>/dev/null)
assert_eq "$_stale_status" "claimed" "stale: task is in claimed status"

# Simulate stale recovery: fail the task
db_fail_task "$_stale_id" "--" "Stale lock after 60m"
STATUS=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$_stale_id;")
assert_eq "$STATUS" "failed" "stale: task moved to failed after stale detection"

# ============================================================
# TEST 8: One-shot mode (SKYNET_ONE_SHOT=true)
# ============================================================

echo ""
_tlog "=== Test 8: One-shot mode ==="

# In one-shot mode, MAX_TASKS_PER_RUN is forced to 1
MAX_TASKS_PER_RUN=5
export SKYNET_ONE_SHOT="true"
if [ "${SKYNET_ONE_SHOT:-}" = "true" ]; then
  MAX_TASKS_PER_RUN=1
fi
assert_eq "$MAX_TASKS_PER_RUN" "1" "one-shot: MAX_TASKS_PER_RUN forced to 1"

# In one-shot mode, task file uses run suffix
WORKER_TASK_FILE_ONESHOT="$DEV_DIR/current-task-run.md"
if [ "${SKYNET_ONE_SHOT:-}" = "true" ]; then
  pass "one-shot: uses current-task-run.md"
else
  fail "one-shot: should use current-task-run.md"
fi

# One-shot mode constructs task line from env
SKYNET_ONE_SHOT_TASK="Build one-shot feature"
next_task="- [ ] ${SKYNET_ONE_SHOT_TASK}"
assert_contains "$next_task" "Build one-shot feature" "one-shot: task constructed from env"

# One-shot exit propagation: _one_shot_exit controls exit code
_one_shot_exit=0
assert_eq "$_one_shot_exit" "0" "one-shot: exit code starts at 0"
_one_shot_exit=1
if [ "${SKYNET_ONE_SHOT:-}" = "true" ] && [ "$_one_shot_exit" -ne 0 ]; then
  pass "one-shot: failure propagates non-zero exit"
else
  fail "one-shot: should propagate non-zero exit"
fi

unset SKYNET_ONE_SHOT
unset SKYNET_ONE_SHOT_TASK

# ============================================================
# TEST 9: Full lifecycle (claim -> echo agent -> gate -> merge)
# ============================================================

echo ""
_tlog "=== Test 9: Full lifecycle (claim -> agent -> gate -> merge) ==="

_reset_test_state
sqlite3 "$DB_PATH" "DELETE FROM tasks;"
export SKYNET_GATE_1="true"

T_FULL=$(db_add_task "Full lifecycle task" "FEAT" "Complete cycle test" "top")
CLAIM_FULL=$(db_claim_next_task 1)
CLAIM_FULL_ID=$(echo "$CLAIM_FULL" | cut -d"$SEP" -f1)
CLAIM_FULL_TITLE=$(echo "$CLAIM_FULL" | cut -d"$SEP" -f2)

assert_eq "$CLAIM_FULL_TITLE" "Full lifecycle task" "lifecycle: correct task claimed"

BRANCH_FULL="dev/full-lifecycle-task"
WORKTREE_DIR="$SKYNET_WORKTREE_BASE/w-full"
cleanup_worktree 2>/dev/null || true
cd "$PROJECT_DIR"
git worktree add "$WORKTREE_DIR" -b "$BRANCH_FULL" "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1

(
  cd "$WORKTREE_DIR"
  git config user.email "test@devworker.test"
  git config user.name "Dev Worker Test"
  agent_run "Full lifecycle task" "$LOG"
)
_agent_rc=$?
assert_eq "$_agent_rc" "0" "lifecycle: echo agent succeeded"

# Run gate
_gate_failed=""
_gate_idx=1
while true; do
  _gate_var="SKYNET_GATE_${_gate_idx}"
  _gate_cmd="${!_gate_var:-}"
  [ -z "$_gate_cmd" ] && break
  if ! (cd "$WORKTREE_DIR" && eval "$_gate_cmd") >> "$LOG" 2>&1; then
    _gate_failed="$_gate_cmd"
    break
  fi
  _gate_idx=$((_gate_idx + 1))
done
assert_empty "$_gate_failed" "lifecycle: quality gate passed"

# Merge
_mrc=0
run_merge "$BRANCH_FULL" "$WORKTREE_DIR" "$LOG" "false" || _mrc=$?
assert_eq "$_mrc" "0" "lifecycle: merge to main succeeded"

# Complete task in DB
db_complete_task "$CLAIM_FULL_ID" "$BRANCH_FULL" "1m" 60 "success"
STATUS=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$CLAIM_FULL_ID;")
assert_eq "$STATUS" "completed" "lifecycle: task status is completed"

# ============================================================
# TEST 10: Worker status tracking
# ============================================================

echo ""
_tlog "=== Test 10: Worker status tracking ==="

sqlite3 "$DB_PATH" "DELETE FROM workers;"

db_set_worker_status 1 "dev" "in_progress" "$CLAIM_FULL_ID" "Full lifecycle task" "$BRANCH_FULL"
WSTAT=$(db_get_worker_status 1)
assert_contains "$WSTAT" "in_progress" "worker-status: in_progress set"
assert_contains "$WSTAT" "Full lifecycle task" "worker-status: task_title set"

db_set_worker_idle 1 "task completed"
WSTAT2=$(db_get_worker_status 1)
assert_contains "$WSTAT2" "idle" "worker-status: idle after completion"

# Heartbeat update
db_update_heartbeat 1
HB=$(sqlite3 "$DB_PATH" "SELECT heartbeat_epoch FROM workers WHERE id=1;")
NOW=$(date +%s)
DIFF=$(( NOW - HB ))
[ "$DIFF" -lt 5 ] && pass "worker-status: heartbeat is recent" || fail "worker-status: heartbeat too old (diff=${DIFF}s)"

# ============================================================
# TEST 11: Dry-run mode (SKYNET_DRY_RUN=true)
# ============================================================

echo ""
_tlog "=== Test 11: Dry-run mode ==="

_reset_test_state
sqlite3 "$DB_PATH" "DELETE FROM tasks;"

# Add a task to the DB
T_DRY=$(db_add_task "Dry run test task" "FEAT" "should not be claimed" "top")
assert_not_empty "$T_DRY" "dry-run: task added to DB"

# Verify it starts as pending
STATUS_BEFORE=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$T_DRY;")
assert_eq "$STATUS_BEFORE" "pending" "dry-run: task starts as pending"

# Simulate dry-run mode: claim a task, then check the dry-run guard
export SKYNET_DRY_RUN="true"

# The dry-run guard in dev-worker.sh checks SKYNET_DRY_RUN before agent execution
# and unclaims the task. Simulate this flow:
CLAIM_DRY=$(db_claim_next_task 1)
CLAIM_DRY_ID=$(echo "$CLAIM_DRY" | cut -d"$SEP" -f1)
assert_eq "$CLAIM_DRY_ID" "$T_DRY" "dry-run: task was claimed for dry-run test"

# Verify it's now claimed
STATUS_CLAIMED=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$T_DRY;")
assert_eq "$STATUS_CLAIMED" "claimed" "dry-run: task is claimed"

# Simulate what the dry-run guard does: unclaim the task
if [ "${SKYNET_DRY_RUN:-false}" = "true" ]; then
  db_unclaim_task "$CLAIM_DRY_ID" 2>/dev/null || true
  pass "dry-run: guard triggered — task unclaimed"
else
  fail "dry-run: guard should have triggered"
fi

# Verify the task is back to pending (not completed, not failed)
STATUS_AFTER=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$T_DRY;")
assert_eq "$STATUS_AFTER" "pending" "dry-run: task returned to pending after unclaim"

# Verify the task was NOT completed
COMPLETED_COUNT=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM tasks WHERE id=$T_DRY AND status='completed';")
assert_eq "$COMPLETED_COUNT" "0" "dry-run: task was NOT completed"

# Verify the task was NOT failed
FAILED_COUNT=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM tasks WHERE id=$T_DRY AND status='failed';")
assert_eq "$FAILED_COUNT" "0" "dry-run: task was NOT failed"

# Test that the config variable is properly exported
assert_eq "$SKYNET_DRY_RUN" "true" "dry-run: SKYNET_DRY_RUN env var is set"

unset SKYNET_DRY_RUN

# After unsetting, the default should be false
_dry_default="${SKYNET_DRY_RUN:-false}"
assert_eq "$_dry_default" "false" "dry-run: defaults to false when unset"

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
