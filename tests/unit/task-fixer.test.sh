#!/usr/bin/env bash
# tests/unit/task-fixer.test.sh — Unit tests for scripts/task-fixer.sh lifecycle
#
# Tests the task-fixer's key lifecycle phases by setting up an isolated environment:
#   - Failed task claim and atomicity
#   - Fix attempt counting and max attempts enforcement
#   - Task escalation to blocked after max attempts
#   - Cool-down logic after consecutive failures
#   - usage_limit_hit detection
#   - Worktree setup with WORKTREE_DELETE_STALE_BRANCH=true
#
# Usage: bash tests/unit/task-fixer.test.sh

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

# ── Setup: create isolated environment ──────────────────────────────

TMPDIR_ROOT=$(mktemp -d)
cleanup() {
  rm -rf "/tmp/skynet-test-fixer-$$"* 2>/dev/null || true
  rm -rf "$TMPDIR_ROOT"
}
trap cleanup EXIT

echo ""
_tlog "=== Setup: creating isolated environment for task-fixer tests ==="

# Create bare remote and clone (needed for worktree tests)
git init --bare "$TMPDIR_ROOT/remote.git" >/dev/null 2>&1
git -C "$TMPDIR_ROOT/remote.git" symbolic-ref HEAD refs/heads/main

git clone "$TMPDIR_ROOT/remote.git" "$TMPDIR_ROOT/project" >/dev/null 2>&1
cd "$TMPDIR_ROOT/project"
git checkout -b main 2>/dev/null || true
git config user.email "test@fixer.test"
git config user.name "Fixer Test"
echo "# Fixer Test Project" > README.md
git add README.md
git commit -m "Initial commit" >/dev/null 2>&1
git push -u origin main >/dev/null 2>&1

# Create .dev/ and config
mkdir -p "$TMPDIR_ROOT/project/.dev"

cat > "$TMPDIR_ROOT/project/.dev/skynet.config.sh" <<CONF
export SKYNET_PROJECT_NAME="test-fixer"
export SKYNET_PROJECT_DIR="$TMPDIR_ROOT/project"
export SKYNET_DEV_DIR="$TMPDIR_ROOT/project/.dev"
export SKYNET_LOCK_PREFIX="/tmp/skynet-test-fixer-$$"
export SKYNET_MAIN_BRANCH="main"
export SKYNET_MAX_WORKERS=2
export SKYNET_MAX_FIXERS=2
export SKYNET_MAX_FIX_ATTEMPTS=3
export SKYNET_AGENT_PLUGIN="echo"
export SKYNET_TYPECHECK_CMD="true"
export SKYNET_GATE_1="true"
export SKYNET_POST_MERGE_TYPECHECK="false"
export SKYNET_POST_MERGE_SMOKE="false"
export SKYNET_BRANCH_PREFIX="dev/"
export SKYNET_STALE_MINUTES=45
export SKYNET_AGENT_TIMEOUT_MINUTES=5
export SKYNET_DEV_PORT=13400
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
export SKYNET_PROJECT_NAME="test-fixer"
export SKYNET_LOCK_PREFIX="/tmp/skynet-test-fixer-$$"
export SKYNET_MAIN_BRANCH="main"
export SKYNET_MAX_WORKERS=2
export SKYNET_MAX_FIXERS=2
export SKYNET_MAX_FIX_ATTEMPTS=3
export SKYNET_STALE_MINUTES=45
export SKYNET_BRANCH_PREFIX="dev/"
export SKYNET_INSTALL_CMD="true"
export SKYNET_TYPECHECK_CMD="true"
export SKYNET_POST_MERGE_TYPECHECK="false"
export SKYNET_POST_MERGE_SMOKE="false"
export SKYNET_TG_ENABLED="false"
export SKYNET_NOTIFY_CHANNELS=""
export SKYNET_DEV_PORT=13400
export SKYNET_AGENT_TIMEOUT_MINUTES=5
export SKYNET_LOCK_BACKEND="file"
export SKYNET_USE_FLOCK="true"
export SKYNET_FIXER_IGNORE_USAGE_LIMIT="true"

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
MAX_FIX_ATTEMPTS=3

# Log file
LOG="$TMPDIR_ROOT/test-fixer.log"
: > "$LOG"

# Redirect pipeline log() to the file
log() { echo "[$(date '+%H:%M:%S')] $*" >> "$LOG"; }

# Stub tg() and emit_event()
tg() { :; }
emit_event() { :; }

# Worktree helpers
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

pass "Setup: isolated task-fixer test environment created"

# ============================================================
# TEST 1: Failed task claim
# ============================================================

echo ""
_tlog "=== Test 1: Failed task claim ==="

sqlite3 "$DB_PATH" "DELETE FROM tasks; DELETE FROM fixer_stats;"

# Create a task and fail it (simulating dev-worker failure)
T1=$(db_add_task "Fix typecheck errors" "FIX" "3 type errors" "top")
sqlite3 "$DB_PATH" "UPDATE tasks SET status='claimed', worker_id=1 WHERE id=$T1;"
db_fail_task "$T1" "dev/fix-typecheck-errors" "typecheck failed: 3 errors"

STATUS=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$T1;")
assert_eq "$STATUS" "failed" "claim: task is in failed status"

# Get pending failures
FAILURES=$(db_get_pending_failures)
assert_not_empty "$FAILURES" "claim: pending failures found"
assert_contains "$FAILURES" "Fix typecheck errors" "claim: our task is in failures list"

# Claim the failure as fixer 1
db_claim_failure "$T1" 1
STATUS=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$T1;")
assert_eq "$STATUS" "fixing-1" "claim: status set to fixing-1"

FIXER_ID=$(sqlite3 "$DB_PATH" "SELECT fixer_id FROM tasks WHERE id=$T1;")
assert_eq "$FIXER_ID" "1" "claim: fixer_id set to 1"

# Double-claim should fail
if db_claim_failure "$T1" 2 2>/dev/null; then
  fail "claim: double-claim should fail"
else
  pass "claim: double-claim rejected"
fi

# Unclaim and verify it returns to failed
db_unclaim_failure "$T1" 1
STATUS=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$T1;")
assert_eq "$STATUS" "failed" "claim: unclaim reverts to failed"

# ============================================================
# TEST 2: Fix attempt counting
# ============================================================

echo ""
_tlog "=== Test 2: Fix attempt counting ==="

sqlite3 "$DB_PATH" "DELETE FROM tasks;"

# Create and fail a task
T2=$(db_add_task "Attempt counting test" "FIX" "" "top")
sqlite3 "$DB_PATH" "UPDATE tasks SET status='claimed', worker_id=1 WHERE id=$T2;"
db_fail_task "$T2" "dev/attempt-test" "initial failure"

# Verify initial attempts = 0
ATTEMPTS=$(sqlite3 "$DB_PATH" "SELECT attempts FROM tasks WHERE id=$T2;")
assert_eq "$ATTEMPTS" "0" "attempts: starts at 0"

# Simulate first fix attempt failure
db_claim_failure "$T2" 1
db_update_failure "$T2" "still failing after attempt 1" 1 "failed"
ATTEMPTS=$(sqlite3 "$DB_PATH" "SELECT attempts FROM tasks WHERE id=$T2;")
assert_eq "$ATTEMPTS" "1" "attempts: incremented to 1"

STATUS=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$T2;")
assert_eq "$STATUS" "failed" "attempts: status reverted to failed"

# Simulate second fix attempt failure
db_claim_failure "$T2" 1
db_update_failure "$T2" "still failing after attempt 2" 2 "failed"
ATTEMPTS=$(sqlite3 "$DB_PATH" "SELECT attempts FROM tasks WHERE id=$T2;")
assert_eq "$ATTEMPTS" "2" "attempts: incremented to 2"

# Simulate third (max) fix attempt — should still record
db_claim_failure "$T2" 1
db_update_failure "$T2" "still failing after attempt 3" 3 "failed"
ATTEMPTS=$(sqlite3 "$DB_PATH" "SELECT attempts FROM tasks WHERE id=$T2;")
assert_eq "$ATTEMPTS" "3" "attempts: incremented to 3 (max)"

# ============================================================
# TEST 3: Task escalation to blocked after max attempts
# ============================================================

echo ""
_tlog "=== Test 3: Escalation to blocked ==="

# T2 now has 3 attempts, which is >= MAX_FIX_ATTEMPTS
fix_attempts=$(sqlite3 "$DB_PATH" "SELECT attempts FROM tasks WHERE id=$T2;")
if [ "$fix_attempts" -ge "$MAX_FIX_ATTEMPTS" ] 2>/dev/null; then
  pass "blocked: attempts ($fix_attempts) >= max ($MAX_FIX_ATTEMPTS)"
else
  fail "blocked: attempts should be >= max"
fi

# Block the task (simulating what task-fixer.sh does)
db_block_task "$T2"
STATUS=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$T2;")
assert_eq "$STATUS" "blocked" "blocked: task status set to blocked"

# Add a blocker entry (simulating task-fixer.sh behavior)
db_add_blocker "Task 'Attempt counting test' failed $MAX_FIX_ATTEMPTS times. Needs human review." "Attempt counting test"
BLOCKER_COUNT=$(db_count_active_blockers)
assert_eq "$BLOCKER_COUNT" "1" "blocked: blocker entry created"

# Verify blocked task cannot be claimed by fixer
FAILURES2=$(db_get_pending_failures)
# Should not contain our blocked task
if echo "$FAILURES2" | grep -qF "Attempt counting test"; then
  fail "blocked: blocked task should not appear in pending failures"
else
  pass "blocked: blocked task not in pending failures"
fi

# ============================================================
# TEST 4: Cool-down logic after consecutive failures
# ============================================================

echo ""
_tlog "=== Test 4: Cool-down logic ==="

sqlite3 "$DB_PATH" "DELETE FROM fixer_stats;"

# Record 5 consecutive failures
for _i in 1 2 3 4 5; do
  db_add_fixer_stat "failure" "failing-task-$_i" 1
done

# Check consecutive failures (same logic as task-fixer.sh)
_consec_all_fail=false
_db_last5=$(db_get_consecutive_failures 5 2>/dev/null || true)
if [ -n "$_db_last5" ]; then
  _fail_count=0
  _total_count=0
  while IFS=$'\x1f' read -r _result; do
    [ -z "$_result" ] && continue
    _total_count=$((_total_count + 1))
    [ "$_result" = "failure" ] && _fail_count=$((_fail_count + 1))
  done <<< "$_db_last5"
  [ "$_total_count" -ge 5 ] && [ "$_fail_count" -ge 5 ] && _consec_all_fail=true
fi

if $_consec_all_fail; then
  pass "cooldown: 5 consecutive failures detected"
else
  fail "cooldown: should detect 5 consecutive failures"
fi

# Record a success, should break the consecutive failure streak
db_add_fixer_stat "success" "fixed-task" 1

_consec_all_fail=false
_db_last5=$(db_get_consecutive_failures 5 2>/dev/null || true)
if [ -n "$_db_last5" ]; then
  _fail_count=0
  _total_count=0
  while IFS=$'\x1f' read -r _result; do
    [ -z "$_result" ] && continue
    _total_count=$((_total_count + 1))
    [ "$_result" = "failure" ] && _fail_count=$((_fail_count + 1))
  done <<< "$_db_last5"
  [ "$_total_count" -ge 5 ] && [ "$_fail_count" -ge 5 ] && _consec_all_fail=true
fi

if $_consec_all_fail; then
  fail "cooldown: should not trigger after a success"
else
  pass "cooldown: success breaks consecutive failure streak"
fi

# Verify fix rate reflects the stats
RATE=$(db_get_fix_rate_24h)
# 1 success out of 6 total = 16.67%, ROUND() -> 17%
assert_eq "$RATE" "17" "cooldown: fix rate is 17% (1/6 rounded)"

# ============================================================
# TEST 5: usage_limit_hit detection
# ============================================================

echo ""
_tlog "=== Test 5: usage_limit_hit detection ==="

# Source the usage_limit_hit function from task-fixer.sh
# (it's defined inline, so we redefine it here for testing)
usage_limit_hit() {
  local log_file="$1"
  [ -f "$log_file" ] || return 1
  tail -n 200 "$log_file" | grep -qiE "usage limit|usage-limit|hit your limit|purchase more credits|resets (at )?[0-9]{1,2}(:[0-9]{2})?[ ]?(am|pm)|credits"
}

# Create a log with usage limit message
USAGE_LOG="$TMPDIR_ROOT/usage-test.log"
echo "Some normal output" > "$USAGE_LOG"
echo "Error: You've hit your limit for the day" >> "$USAGE_LOG"

if usage_limit_hit "$USAGE_LOG"; then
  pass "usage-limit: detects 'hit your limit'"
else
  fail "usage-limit: should detect limit message"
fi

# Test: log without usage limit
NORMAL_LOG="$TMPDIR_ROOT/normal-test.log"
echo "Normal agent output" > "$NORMAL_LOG"
echo "Task completed successfully" >> "$NORMAL_LOG"

if usage_limit_hit "$NORMAL_LOG"; then
  fail "usage-limit: should not trigger on normal log"
else
  pass "usage-limit: normal log not flagged"
fi

# Test: non-existent file
if usage_limit_hit "$TMPDIR_ROOT/nonexistent.log"; then
  fail "usage-limit: should return 1 for missing file"
else
  pass "usage-limit: returns 1 for missing file"
fi

# Test: credits message variant
CREDITS_LOG="$TMPDIR_ROOT/credits-test.log"
echo "purchase more credits to continue" > "$CREDITS_LOG"

if usage_limit_hit "$CREDITS_LOG"; then
  pass "usage-limit: detects 'purchase more credits'"
else
  fail "usage-limit: should detect credits message"
fi

# Test: resets at time variant
RESETS_LOG="$TMPDIR_ROOT/resets-test.log"
echo "Usage limit - resets at 5pm" > "$RESETS_LOG"

if usage_limit_hit "$RESETS_LOG"; then
  pass "usage-limit: detects 'resets at' pattern"
else
  fail "usage-limit: should detect resets message"
fi

# ============================================================
# TEST 6: Worktree setup with WORKTREE_DELETE_STALE_BRANCH
# ============================================================

echo ""
_tlog "=== Test 6: Worktree setup with WORKTREE_DELETE_STALE_BRANCH ==="

cd "$PROJECT_DIR"

# Task-fixer uses these settings
WORKTREE_INSTALL_STRICT=false
WORKTREE_DELETE_STALE_BRANCH=true

# Create a stale branch (simulating a leftover from a failed task)
STALE_BRANCH="fix/stale-leftover"
git checkout -b "$STALE_BRANCH" >/dev/null 2>&1
echo "stale content" > stale-file.txt
git add stale-file.txt
git commit -m "stale commit" >/dev/null 2>&1
git checkout "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1

if git show-ref --verify --quiet "refs/heads/$STALE_BRANCH" 2>/dev/null; then
  pass "worktree-stale: stale branch exists before cleanup"
else
  fail "worktree-stale: stale branch should exist"
fi

# When WORKTREE_DELETE_STALE_BRANCH=true, the fixer would delete the branch
# before creating a fresh one. Simulate this:
if $WORKTREE_DELETE_STALE_BRANCH; then
  git branch -D "$STALE_BRANCH" 2>/dev/null || true
fi

if git show-ref --verify --quiet "refs/heads/$STALE_BRANCH" 2>/dev/null; then
  fail "worktree-stale: branch should be deleted"
else
  pass "worktree-stale: stale branch deleted"
fi

# Create a fresh worktree (like the fixer would)
FRESH_BRANCH="fix/fresh-fix-branch"
WORKTREE_DIR="$SKYNET_WORKTREE_BASE/fixer-1"
cleanup_worktree 2>/dev/null || true
git worktree add "$WORKTREE_DIR" -b "$FRESH_BRANCH" "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1

[ -d "$WORKTREE_DIR" ] && pass "worktree-stale: fresh worktree created" || fail "worktree-stale: fresh worktree not created"

if git show-ref --verify --quiet "refs/heads/$FRESH_BRANCH" 2>/dev/null; then
  pass "worktree-stale: fresh branch created from main"
else
  fail "worktree-stale: fresh branch not created"
fi

cleanup_worktree "$FRESH_BRANCH"

# ============================================================
# TEST 7: Fixed task lifecycle (claim failure -> fix -> merge)
# ============================================================

echo ""
_tlog "=== Test 7: Fixed task lifecycle ==="

sqlite3 "$DB_PATH" "DELETE FROM tasks;"
cd "$PROJECT_DIR"
git checkout "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1 || true

# Create and fail a task
T7=$(db_add_task "Fix login bug" "FIX" "Login fails on mobile" "top")
sqlite3 "$DB_PATH" "UPDATE tasks SET status='claimed', worker_id=1 WHERE id=$T7;"
db_fail_task "$T7" "dev/fix-login-bug" "typecheck failed"

# Claim as fixer
db_claim_failure "$T7" 1
STATUS=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$T7;")
assert_eq "$STATUS" "fixing-1" "fix-lifecycle: claimed by fixer"

# Simulate successful fix + merge
db_fix_task "$T7" "merged to main" 1 "typecheck failed"
STATUS=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$T7;")
assert_eq "$STATUS" "fixed" "fix-lifecycle: task status is fixed"

ATTEMPTS=$(sqlite3 "$DB_PATH" "SELECT attempts FROM tasks WHERE id=$T7;")
assert_eq "$ATTEMPTS" "1" "fix-lifecycle: attempts = 1"

# ============================================================
# TEST 8: Multiple fixer instances
# ============================================================

echo ""
_tlog "=== Test 8: Multiple fixer instances ==="

sqlite3 "$DB_PATH" "DELETE FROM tasks;"

# Create 2 failed tasks
F1=$(db_add_task "Fixer1 task" "FIX" "" "top")
F2=$(db_add_task "Fixer2 task" "FIX" "" "bottom")
sqlite3 "$DB_PATH" "UPDATE tasks SET status='claimed', worker_id=1 WHERE id=$F1;"
sqlite3 "$DB_PATH" "UPDATE tasks SET status='claimed', worker_id=2 WHERE id=$F2;"
db_fail_task "$F1" "dev/fixer1-task" "error1"
db_fail_task "$F2" "dev/fixer2-task" "error2"

# Fixer 1 claims first failure
db_claim_failure "$F1" 1
STATUS1=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$F1;")
assert_eq "$STATUS1" "fixing-1" "multi-fixer: fixer 1 claims task"

# Fixer 2 claims second failure
db_claim_failure "$F2" 2
STATUS2=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$F2;")
assert_eq "$STATUS2" "fixing-2" "multi-fixer: fixer 2 claims different task"

# Verify each fixer has its own task
FIXER1_ID=$(sqlite3 "$DB_PATH" "SELECT fixer_id FROM tasks WHERE id=$F1;")
FIXER2_ID=$(sqlite3 "$DB_PATH" "SELECT fixer_id FROM tasks WHERE id=$F2;")
assert_eq "$FIXER1_ID" "1" "multi-fixer: task 1 owned by fixer 1"
assert_eq "$FIXER2_ID" "2" "multi-fixer: task 2 owned by fixer 2"

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
