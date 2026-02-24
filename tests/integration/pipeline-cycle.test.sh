#!/usr/bin/env bash
# tests/integration/pipeline-cycle.test.sh — Full pipeline lifecycle test
#
# Exercises: seed task -> claim -> implement (echo agent) -> gates -> merge -> verify
# Uses the echo agent for deterministic, fast execution without LLM calls.
#
# Requirements: git, sqlite3, bash
# Usage: bash tests/integration/pipeline-cycle.test.sh

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

# log() used by pipeline modules — suppress to log file (set after LOG is defined)
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

assert_gt() {
  local actual="$1" threshold="$2" msg="$3"
  if [ "$actual" -gt "$threshold" ] 2>/dev/null; then pass "$msg"
  else fail "$msg (expected > $threshold, got '$actual')"; fi
}

# Wrapper: call do_merge_to_main and restore set +e afterward.
# do_merge_to_main() enables set -e internally which leaks into the caller.
# This wrapper captures the return code safely and restores our test-friendly
# shell options (no -e). Also suppresses git stdout noise.
run_merge() {
  local _rm_rc=0
  _MERGE_STATE_COMMIT_FN=""
  do_merge_to_main "$@" >>"$LOG" || _rm_rc=$?
  # Restore test-friendly shell options: -e leaks from do_merge_to_main
  set +e
  return $_rm_rc
}

# ── Setup: create isolated environment ──────────────────────────────

TMPDIR_ROOT=$(mktemp -d)
cleanup() {
  # Remove lock files
  rm -rf "/tmp/skynet-test-integration-$$"* 2>/dev/null || true
  rm -rf "$TMPDIR_ROOT"
}
trap cleanup EXIT

echo ""
_tlog "=== Setup: creating isolated git environment ==="

# Step 1-3: Create bare remote and clone as project
# Force 'main' as default branch — CI (Ubuntu) may default to 'master'
git init --bare "$TMPDIR_ROOT/remote.git" >/dev/null 2>&1
git -C "$TMPDIR_ROOT/remote.git" symbolic-ref HEAD refs/heads/main
git clone "$TMPDIR_ROOT/remote.git" "$TMPDIR_ROOT/project" >/dev/null 2>&1

# Step 4: Create initial commit and push
cd "$TMPDIR_ROOT/project"
git checkout -b main 2>/dev/null || true
git config user.email "test@integration.test"
git config user.name "Integration Test"
echo "# Test Project" > README.md
git add README.md
git commit -m "Initial commit" >/dev/null 2>&1
git push -u origin main >/dev/null 2>&1

# Step 5-6: Create .dev/ and config
mkdir -p "$TMPDIR_ROOT/project/.dev"

cat > "$TMPDIR_ROOT/project/.dev/skynet.config.sh" <<CONF
export SKYNET_PROJECT_NAME="test-integration"
export SKYNET_PROJECT_DIR="$TMPDIR_ROOT/project"
export SKYNET_DEV_DIR="$TMPDIR_ROOT/project/.dev"
export SKYNET_LOCK_PREFIX="/tmp/skynet-test-integration-$$"
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
export SKYNET_DEV_PORT=13100
export SKYNET_INSTALL_CMD="true"
export SKYNET_TG_ENABLED="false"
export SKYNET_NOTIFY_CHANNELS=""
CONF

# Step 7: Symlink scripts directory
ln -s "$REPO_ROOT/scripts" "$TMPDIR_ROOT/project/.dev/scripts"

# Step 8: Create required state files
touch "$TMPDIR_ROOT/project/.dev/backlog.md"
touch "$TMPDIR_ROOT/project/.dev/completed.md"
touch "$TMPDIR_ROOT/project/.dev/failed-tasks.md"
touch "$TMPDIR_ROOT/project/.dev/blockers.md"
touch "$TMPDIR_ROOT/project/.dev/mission.md"

# Step 9-10: Set environment and source modules
export SKYNET_DEV_DIR="$TMPDIR_ROOT/project/.dev"
export SKYNET_PROJECT_DIR="$TMPDIR_ROOT/project"
export SKYNET_PROJECT_NAME="test-integration"
export SKYNET_LOCK_PREFIX="/tmp/skynet-test-integration-$$"
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
export SKYNET_DEV_PORT=13100
export SKYNET_AGENT_TIMEOUT_MINUTES=5

# Derived paths (match what _config.sh would set)
PROJECT_DIR="$SKYNET_PROJECT_DIR"
DEV_DIR="$SKYNET_DEV_DIR"
SCRIPTS_DIR="$SKYNET_DEV_DIR/scripts"
BACKLOG="$DEV_DIR/backlog.md"
COMPLETED="$DEV_DIR/completed.md"
FAILED="$DEV_DIR/failed-tasks.md"
BLOCKERS="$DEV_DIR/blockers.md"

# Source cross-platform compat (needed by _locks.sh and _merge.sh)
source "$REPO_ROOT/scripts/_compat.sh"

# Source notification stubs — _notify.sh needs SKYNET_SCRIPTS_DIR
SKYNET_SCRIPTS_DIR="$REPO_ROOT/scripts"
source "$REPO_ROOT/scripts/_notify.sh"

# Source events (needs DEV_DIR, db_add_event — stub it until db loaded)
db_add_event() { :; }
source "$REPO_ROOT/scripts/_events.sh"

# Source pluggable lock backend (needed by _locks.sh)
source "$REPO_ROOT/scripts/_lock_backend.sh"

# Source lock helpers (needs SKYNET_LOCK_PREFIX)
source "$REPO_ROOT/scripts/_locks.sh"

# Source DB layer (needs SKYNET_DEV_DIR)
source "$REPO_ROOT/scripts/_db.sh"

# Source merge helper (needs _locks.sh, _compat.sh)
source "$REPO_ROOT/scripts/_merge.sh"

# Source echo agent plugin
source "$REPO_ROOT/scripts/agents/echo.sh"

# Unset the stub now that db is available
unset -f db_add_event 2>/dev/null || true
source "$REPO_ROOT/scripts/_events.sh"

# Initialize database (suppress stdout noise from schema creation)
db_init >/dev/null 2>&1

# Unit separator for parsing db output
SEP=$'\x1f'

# Helper: git_pull_with_retry and git_push_with_retry need LOG defined
LOG="$TMPDIR_ROOT/test-worker.log"
: > "$LOG"

# Now that LOG is defined, redirect pipeline log() to the file (silences
# WARNING messages from _validate_status_transition and other internal noise)
log() { echo "[$(date '+%H:%M:%S')] $*" >> "$LOG"; }

# Define git helpers that _merge.sh expects
git_pull_with_retry() {
  local max_attempts="${1:-3}"
  local attempt=1
  while [ "$attempt" -le "$max_attempts" ]; do
    if git pull origin "$SKYNET_MAIN_BRANCH" 2>>"$LOG"; then
      return 0
    fi
    attempt=$((attempt + 1))
    [ "$attempt" -le "$max_attempts" ] && sleep 1
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
    [ "$attempt" -le "$max_attempts" ] && sleep 1
  done
  return 1
}

# Define cleanup_worktree for merge helper
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

pass "Setup: isolated environment created"

# ============================================================
# TEST 1: Simple task claim -> implement -> merge cycle
# ============================================================

echo ""
_tlog "=== Test 1: Simple task claim -> implement -> merge ==="

# Add a task
TASK1_ID=$(db_add_task "Create hello world" "FEAT" "Simple test task" "top")
assert_not_empty "$TASK1_ID" "task 1: added to database"

# Verify task is pending
STATUS=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$TASK1_ID;")
assert_eq "$STATUS" "pending" "task 1: initial status is pending"

# Claim the task
CLAIM_RESULT=$(db_claim_next_task 1)
assert_not_empty "$CLAIM_RESULT" "task 1: claim returned result"

CLAIM_ID=$(echo "$CLAIM_RESULT" | cut -d"$SEP" -f1)
CLAIM_TITLE=$(echo "$CLAIM_RESULT" | cut -d"$SEP" -f2)
assert_eq "$CLAIM_ID" "$TASK1_ID" "task 1: claimed correct task ID"
assert_eq "$CLAIM_TITLE" "Create hello world" "task 1: claimed correct title"

# Verify status is now claimed
STATUS=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$TASK1_ID;")
assert_eq "$STATUS" "claimed" "task 1: status changed to claimed"

# Create a branch name for the task (matching pipeline convention)
BRANCH_1="dev/create-hello-world"
cd "$PROJECT_DIR"

# Create worktree for the feature branch
WORKTREE_DIR="$SKYNET_WORKTREE_BASE/w1"
git worktree add "$WORKTREE_DIR" -b "$BRANCH_1" "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1
[ -d "$WORKTREE_DIR" ] && pass "task 1: worktree created" || fail "task 1: worktree not created"

# Run the echo agent in the worktree (simulates what dev-worker does)
(
  cd "$WORKTREE_DIR"
  git config user.email "test@integration.test"
  git config user.name "Integration Test"
  agent_run "Create hello world" "$LOG"
)
AGENT_RC=$?
assert_eq "$AGENT_RC" "0" "task 1: echo agent succeeded"

# Verify the echo agent created a file and committed
AGENT_COMMITS=$(cd "$WORKTREE_DIR" && git log --oneline "$SKYNET_MAIN_BRANCH"..HEAD 2>/dev/null | wc -l | tr -d ' ')
assert_gt "$AGENT_COMMITS" "0" "task 1: echo agent made at least one commit"

# Set worker status
db_set_worker_status 1 "dev" "in_progress" "$TASK1_ID" "Create hello world" "$BRANCH_1" 2>/dev/null || true

# Merge to main using the shared merge function (run_merge restores set +e)
_merge_rc=0
run_merge "$BRANCH_1" "$WORKTREE_DIR" "$LOG" "false" || _merge_rc=$?
assert_eq "$_merge_rc" "0" "task 1: merge to main succeeded (rc=0)"

# Verify the merge commit is on main
cd "$PROJECT_DIR"
git checkout "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1 || true
MAIN_LOG=$(git log --oneline -5)
assert_contains "$MAIN_LOG" "echo-agent" "task 1: echo agent commit visible on main"

# Mark task completed in DB (simulates what worker does after merge)
db_complete_task "$TASK1_ID" "$BRANCH_1" "1m" 60 "success" 2>/dev/null || true

STATUS=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$TASK1_ID;")
assert_eq "$STATUS" "completed" "task 1: final status is completed"

# Verify worker status can be set to idle
db_set_worker_idle 1 "task completed" 2>/dev/null || true
WSTAT=$(db_get_worker_status 1)
assert_contains "$WSTAT" "idle" "task 1: worker set to idle after completion"

# Verify the feature branch was cleaned up (do_merge_to_main deletes it)
if git show-ref --verify --quiet "refs/heads/$BRANCH_1" 2>/dev/null; then
  fail "task 1: feature branch should be deleted after merge"
else
  pass "task 1: feature branch deleted after merge"
fi

# ============================================================
# TEST 2: Blocked task resolution
# ============================================================

echo ""
_tlog "=== Test 2: Blocked task resolution ==="

# Add task A (unblocked)
TASK_A_ID=$(db_add_task "Build feature A" "FEAT" "" "top")
assert_not_empty "$TASK_A_ID" "blocked: task A added"

# Add task B blocked by task A
TASK_B_ID=$(db_add_task "Build feature B" "FEAT" "" "bottom" "Build feature A")
assert_not_empty "$TASK_B_ID" "blocked: task B added"

# Verify task B has blocked_by set
BLOCKED_BY=$(sqlite3 "$DB_PATH" "SELECT blocked_by FROM tasks WHERE id=$TASK_B_ID;")
assert_eq "$BLOCKED_BY" "Build feature A" "blocked: task B has correct blocked_by"

# Claim next task — should get task A (unblocked, higher priority)
CLAIM_A=$(db_claim_next_task 1)
CLAIM_A_TITLE=$(echo "$CLAIM_A" | cut -d"$SEP" -f2)
assert_eq "$CLAIM_A_TITLE" "Build feature A" "blocked: worker claims unblocked task A first"

# Verify task B is still pending (not claimable while A is not completed)
CLAIM_B_ATTEMPT=$(db_claim_next_task 2)
CLAIM_B_TITLE=$(echo "$CLAIM_B_ATTEMPT" | cut -d"$SEP" -f2)
if [ "$CLAIM_B_TITLE" = "Build feature B" ]; then
  fail "blocked: task B should NOT be claimable while A is not completed"
else
  pass "blocked: task B not claimed while task A incomplete"
fi

# Complete task A
CLAIM_A_ID=$(echo "$CLAIM_A" | cut -d"$SEP" -f1)
db_complete_task "$CLAIM_A_ID" "dev/build-feature-a" "2m" 120 "success" 2>/dev/null || true

STATUS_A=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$CLAIM_A_ID;")
assert_eq "$STATUS_A" "completed" "blocked: task A completed"

# Now task B should be claimable
# First unclaim worker 2 if it claimed something else
if [ -n "$CLAIM_B_TITLE" ]; then
  _temp_id=$(echo "$CLAIM_B_ATTEMPT" | cut -d"$SEP" -f1)
  [ -n "$_temp_id" ] && db_unclaim_task "$_temp_id" 2>/dev/null || true
fi

CLAIM_B=$(db_claim_next_task 2)
CLAIM_B_TITLE=$(echo "$CLAIM_B" | cut -d"$SEP" -f2)
assert_eq "$CLAIM_B_TITLE" "Build feature B" "blocked: task B claimable after task A completed"

# Complete task B
CLAIM_B_ID=$(echo "$CLAIM_B" | cut -d"$SEP" -f1)
db_complete_task "$CLAIM_B_ID" "dev/build-feature-b" "3m" 180 "success" 2>/dev/null || true

STATUS_B=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$CLAIM_B_ID;")
assert_eq "$STATUS_B" "completed" "blocked: task B completed after unblocking"

# ============================================================
# TEST 3: Echo agent file creation and git integration
# ============================================================

echo ""
_tlog "=== Test 3: Echo agent file creation and git integration ==="

cd "$PROJECT_DIR"
git checkout "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1 || true

# Add a new task
TASK3_ID=$(db_add_task "Implement user dashboard" "FEAT" "Build the dashboard page" "top")
CLAIM3=$(db_claim_next_task 1)
CLAIM3_ID=$(echo "$CLAIM3" | cut -d"$SEP" -f1)
CLAIM3_TITLE=$(echo "$CLAIM3" | cut -d"$SEP" -f2)

assert_eq "$CLAIM3_TITLE" "Implement user dashboard" "agent: correct task claimed"

BRANCH_3="dev/implement-user-dashboard"

# Create worktree
WORKTREE_DIR="$SKYNET_WORKTREE_BASE/w1"
cleanup_worktree 2>/dev/null || true
git worktree add "$WORKTREE_DIR" -b "$BRANCH_3" "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1

# Run echo agent
(
  cd "$WORKTREE_DIR"
  git config user.email "test@integration.test"
  git config user.name "Integration Test"
  agent_run "Implement user dashboard" "$LOG"
)
AGENT_RC=$?
assert_eq "$AGENT_RC" "0" "agent: echo agent ran successfully"

# Verify the placeholder file was created (use specific filename, not glob,
# since earlier echo-agent files from Test 1 may also exist in the worktree)
EXPECTED_FILE="echo-agent-implement-user-dashboard.md"
CREATED_FILE=""
[ -f "$WORKTREE_DIR/$EXPECTED_FILE" ] && CREATED_FILE="$EXPECTED_FILE"
assert_not_empty "$CREATED_FILE" "agent: placeholder file created by echo agent"

# Verify the placeholder contains the task description
if [ -n "$CREATED_FILE" ]; then
  FILE_CONTENT=$(cat "$WORKTREE_DIR/$CREATED_FILE")
  assert_contains "$FILE_CONTENT" "Implement user dashboard" "agent: placeholder contains task description"
  assert_contains "$FILE_CONTENT" "Echo Agent" "agent: placeholder has echo agent header"
fi

# Verify git commit was made on the branch
COMMIT_MSG=$(cd "$WORKTREE_DIR" && git log -1 --format=%s)
assert_contains "$COMMIT_MSG" "echo-agent" "agent: commit message from echo agent"

# Merge and complete
_merge_rc=0
run_merge "$BRANCH_3" "$WORKTREE_DIR" "$LOG" "false" || _merge_rc=$?
assert_eq "$_merge_rc" "0" "agent: merge to main succeeded"

db_complete_task "$CLAIM3_ID" "$BRANCH_3" "1m" 60 "success" 2>/dev/null || true

# Verify the echo agent file is now on main
cd "$PROJECT_DIR"
git checkout "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1 || true
MAIN_FILE=$(ls echo-agent-*.md 2>/dev/null | head -1)
assert_not_empty "$MAIN_FILE" "agent: echo agent file present on main after merge"

# ============================================================
# TEST 4: State file export
# ============================================================

echo ""
_tlog "=== Test 4: State file export ==="

# Add a few more tasks for richer state
db_add_task "Pending task one" "CHORE" "A pending task" "bottom" >/dev/null
db_add_task "Pending task two" "FIX" "Another pending task" "bottom" >/dev/null

# Export state files
db_export_state_files

# Verify backlog.md has pending tasks
BACKLOG_CONTENT=$(cat "$BACKLOG" 2>/dev/null || echo "")
assert_contains "$BACKLOG_CONTENT" "Pending task one" "export: backlog.md contains pending task one"
assert_contains "$BACKLOG_CONTENT" "Pending task two" "export: backlog.md contains pending task two"
assert_contains "$BACKLOG_CONTENT" "CHORE" "export: backlog.md contains task tags"

# Verify completed.md has completed tasks
COMPLETED_CONTENT=$(cat "$COMPLETED" 2>/dev/null || echo "")
assert_contains "$COMPLETED_CONTENT" "Create hello world" "export: completed.md has completed task"
assert_contains "$COMPLETED_CONTENT" "Build feature A" "export: completed.md has task A"
assert_contains "$COMPLETED_CONTENT" "Build feature B" "export: completed.md has task B"
assert_contains "$COMPLETED_CONTENT" "Implement user dashboard" "export: completed.md has dashboard task"

# Verify the export format (markdown table)
assert_contains "$COMPLETED_CONTENT" "| Date |" "export: completed.md has table header"

# ============================================================
# TEST 5: Task failure and recording
# ============================================================

echo ""
_tlog "=== Test 5: Task failure recording ==="

FAIL_TASK_ID=$(db_add_task "Failing task test" "FIX" "" "top")
CLAIM_FAIL=$(db_claim_next_task 1)
CLAIM_FAIL_ID=$(echo "$CLAIM_FAIL" | cut -d"$SEP" -f1)

# Simulate a gate failure
db_fail_task "$CLAIM_FAIL_ID" "dev/failing-task-test" "typecheck failed: 3 errors"

STATUS_FAIL=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$CLAIM_FAIL_ID;")
assert_eq "$STATUS_FAIL" "failed" "failure: task status set to failed"

ERROR_MSG=$(sqlite3 "$DB_PATH" "SELECT error FROM tasks WHERE id=$CLAIM_FAIL_ID;")
assert_eq "$ERROR_MSG" "typecheck failed: 3 errors" "failure: error message stored"

# Export and verify failed-tasks.md
db_export_state_files
FAILED_CONTENT=$(cat "$FAILED" 2>/dev/null || echo "")
assert_contains "$FAILED_CONTENT" "Failing task test" "failure: failed-tasks.md has the failed task"
assert_contains "$FAILED_CONTENT" "typecheck failed" "failure: failed-tasks.md has error message"

# ============================================================
# TEST 6: Full round-trip with merge lock
# ============================================================

echo ""
_tlog "=== Test 6: Merge lock acquire/release cycle ==="

cd "$PROJECT_DIR"
git checkout "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1 || true

# Acquire merge lock
acquire_merge_lock
ML_RC=$?
assert_eq "$ML_RC" "0" "merge lock: acquired successfully"

# Verify lock state (flock mode uses a file; legacy mode uses a directory)
if [ "${SKYNET_USE_FLOCK:-true}" = "true" ] && { command -v flock >/dev/null 2>&1 || command -v perl >/dev/null 2>&1; }; then
  # flock mode: verify owner file exists with our PID
  [ -f "${MERGE_FLOCK}.owner" ] && pass "merge lock: flock owner file exists" || fail "merge lock: flock owner file missing"
  ML_PID=$(cat "${MERGE_FLOCK}.owner" 2>/dev/null || echo "")
  assert_eq "$ML_PID" "$$" "merge lock: flock owner records our PID"
else
  # Legacy mkdir mode
  [ -d "$MERGE_LOCK" ] && pass "merge lock: lock directory exists" || fail "merge lock: lock directory missing"
  ML_PID=$(cat "$MERGE_LOCK/pid" 2>/dev/null || echo "")
  assert_eq "$ML_PID" "$$" "merge lock: PID file contains our PID"
fi

# Release the lock
release_merge_lock
if [ "${SKYNET_USE_FLOCK:-true}" = "true" ] && { command -v flock >/dev/null 2>&1 || command -v perl >/dev/null 2>&1; }; then
  [ ! -f "${MERGE_FLOCK}.owner" ] && pass "merge lock: released successfully" || fail "merge lock: owner file should be removed after release"
else
  [ ! -d "$MERGE_LOCK" ] && pass "merge lock: released successfully" || fail "merge lock: should be removed after release"
fi

# ============================================================
# TEST 7: Multiple task cycle (end-to-end pipeline)
# ============================================================

echo ""
_tlog "=== Test 7: Multiple tasks processed sequentially ==="

cd "$PROJECT_DIR"
git checkout "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1 || true

# Mark leftover pending tasks from earlier tests as done so they don't interfere
sqlite3 "$DB_PATH" "UPDATE tasks SET status='done' WHERE status='pending';"

# Seed 3 tasks
T7A_ID=$(db_add_task "Pipeline task alpha" "FEAT" "" "top")
T7B_ID=$(db_add_task "Pipeline task beta" "FEAT" "" "bottom")
T7C_ID=$(db_add_task "Pipeline task gamma" "FEAT" "" "bottom")

COMPLETED_BEFORE=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM tasks WHERE status='completed';")

# Track completed task IDs for verification
T7_COMPLETED_IDS=""

for iter in 1 2 3; do
  # Claim
  _claim=$(db_claim_next_task 1)
  [ -z "$_claim" ] && break
  _cid=$(echo "$_claim" | cut -d"$SEP" -f1)
  _ctitle=$(echo "$_claim" | cut -d"$SEP" -f2)
  _branch="dev/pipeline-task-$(echo "$_ctitle" | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | tr -cd 'a-z0-9-' | head -c 30)"

  # Create worktree
  WORKTREE_DIR="$SKYNET_WORKTREE_BASE/w1"
  cleanup_worktree 2>/dev/null || true
  git worktree add "$WORKTREE_DIR" -b "$_branch" "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1

  # Run echo agent
  (
    cd "$WORKTREE_DIR"
    git config user.email "test@integration.test"
    git config user.name "Integration Test"
    agent_run "$_ctitle" "$LOG"
  )

  # Merge (run_merge restores set +e)
  _mrc=0
  run_merge "$_branch" "$WORKTREE_DIR" "$LOG" "false" || _mrc=$?

  if [ "$_mrc" -eq 0 ]; then
    db_complete_task "$_cid" "$_branch" "1m" 60 "success" 2>/dev/null || true
    T7_COMPLETED_IDS="$T7_COMPLETED_IDS $_cid"
  else
    db_fail_task "$_cid" "$_branch" "merge failed (rc=$_mrc)" 2>/dev/null || true
  fi

  cd "$PROJECT_DIR"
  git checkout "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1 || true
done

COMPLETED_AFTER=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM tasks WHERE status='completed';")
NEWLY_COMPLETED=$((COMPLETED_AFTER - COMPLETED_BEFORE))

assert_eq "$NEWLY_COMPLETED" "3" "multi-task: all 3 tasks completed"

# Verify the 3 seeded tasks show as completed
for _tid in $T7A_ID $T7B_ID $T7C_ID; do
  _s=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$_tid;")
  assert_eq "$_s" "completed" "multi-task: task $_tid completed"
done

# Verify main has multiple echo-agent commits
ECHO_COMMITS=$(cd "$PROJECT_DIR" && git log --oneline | grep -c "echo-agent" || echo 0)
assert_gt "$ECHO_COMMITS" "2" "multi-task: multiple echo-agent commits on main"

# ============================================================
# TEST 8: Agent failure moves task to failed
# ============================================================

echo ""
_tlog "=== Test 8: Agent failure moves task to failed ==="

cd "$PROJECT_DIR"
git checkout "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1 || true

# Save the original agent_run function
eval "$(declare -f agent_run | sed '1s/agent_run/_orig_agent_run/')"

# Override agent_run to simulate failure (non-zero exit)
agent_run() {
  local prompt="$1"
  local log_file="${2:-/dev/null}"
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] failing-agent: simulated failure" >> "$log_file"
  return 1
}

# Add a task that will fail via the broken agent
FAIL_AGENT_ID=$(db_add_task "Agent failure test task" "TEST" "This task will fail" "top")
assert_not_empty "$FAIL_AGENT_ID" "agent-fail: task added"

# Claim the task
FAIL_CLAIM=$(db_claim_next_task 1)
FAIL_CLAIM_ID=$(echo "$FAIL_CLAIM" | cut -d"$SEP" -f1)
FAIL_CLAIM_TITLE=$(echo "$FAIL_CLAIM" | cut -d"$SEP" -f2)
assert_eq "$FAIL_CLAIM_TITLE" "Agent failure test task" "agent-fail: correct task claimed"

# Create worktree and run the failing agent
BRANCH_FAIL="dev/agent-failure-test-task"
WORKTREE_DIR="$SKYNET_WORKTREE_BASE/w1"
cleanup_worktree 2>/dev/null || true
git worktree add "$WORKTREE_DIR" -b "$BRANCH_FAIL" "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1

(
  cd "$WORKTREE_DIR"
  git config user.email "test@integration.test"
  git config user.name "Integration Test"
  agent_run "Agent failure test task" "$LOG"
)
AGENT_FAIL_RC=$?

# Agent should have returned non-zero
if [ "$AGENT_FAIL_RC" -ne 0 ]; then
  pass "agent-fail: agent returned non-zero ($AGENT_FAIL_RC)"
else
  fail "agent-fail: agent should have returned non-zero"
fi

# Simulate what dev-worker.sh does on agent failure: mark task as failed
cleanup_worktree "$BRANCH_FAIL"
db_fail_task "$FAIL_CLAIM_ID" "$BRANCH_FAIL" "claude exit code $AGENT_FAIL_RC" 2>/dev/null || true

# Verify the task is now failed
FAIL_STATUS=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$FAIL_CLAIM_ID;")
assert_eq "$FAIL_STATUS" "failed" "agent-fail: task status set to failed"

# Verify error message is recorded
FAIL_ERROR=$(sqlite3 "$DB_PATH" "SELECT error FROM tasks WHERE id=$FAIL_CLAIM_ID;")
assert_contains "$FAIL_ERROR" "exit code" "agent-fail: error message recorded"

# Verify the worker can continue to process more tasks (claim next)
NEXT_TASK_ID=$(db_add_task "Task after agent failure" "TEST" "Should be claimable" "top")
NEXT_CLAIM=$(db_claim_next_task 1)
NEXT_CLAIM_TITLE=$(echo "$NEXT_CLAIM" | cut -d"$SEP" -f2)
assert_eq "$NEXT_CLAIM_TITLE" "Task after agent failure" "agent-fail: worker claims next task after failure"

# Clean up: complete the next task so it doesn't affect counts
NEXT_CLAIM_ID=$(echo "$NEXT_CLAIM" | cut -d"$SEP" -f1)
db_complete_task "$NEXT_CLAIM_ID" "dev/task-after-failure" "1m" 60 "success" 2>/dev/null || true

# Restore original agent_run
eval "$(declare -f _orig_agent_run | sed '1s/_orig_agent_run/agent_run/')"

# ============================================================
# TEST 9: Database counts after full run
# ============================================================

echo ""
_tlog "=== Test 9: Database state consistency ==="

TOTAL_COMPLETED=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM tasks WHERE status='completed';")
TOTAL_FAILED=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM tasks WHERE status='failed';")
TOTAL_PENDING=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM tasks WHERE status='pending';")

# We completed: hello world, feature A, feature B, dashboard, alpha, beta, gamma, task-after-failure = 8
assert_eq "$TOTAL_COMPLETED" "8" "db state: 8 total completed tasks"

# We failed: failing task test + agent failure test = 2
assert_eq "$TOTAL_FAILED" "2" "db state: 2 total failed tasks"

# Pending task one and two were marked done in Test 7 setup, so 0 pending remain
assert_eq "$TOTAL_PENDING" "0" "db state: 0 remaining pending tasks"

# Verify no orphaned claimed tasks
ORPHANED=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM tasks WHERE status='claimed';")
assert_eq "$ORPHANED" "0" "db state: no orphaned claimed tasks"

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
