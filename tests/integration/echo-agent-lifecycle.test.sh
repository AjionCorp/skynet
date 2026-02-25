#!/usr/bin/env bash
# tests/integration/echo-agent-lifecycle.test.sh — Echo agent end-to-end lifecycle
#
# Validates the complete echo agent lifecycle from claim through merge:
#   1. Plugin interface (agent_check, agent_run)
#   2. Prompt parsing (direct title vs "Your task:" prefix)
#   3. Slug generation and placeholder file content
#   4. SKYNET_ECHO_FAIL failure simulation
#   5. SKYNET_ECHO_DELAY work simulation
#   6. Git precondition validation
#   7. Full lifecycle: seed → claim → worktree → echo agent → gates → merge → verify
#   8. Task-fixer retry after echo agent failure
#   9. Sequential multi-task lifecycle with state export
#  10. Lifecycle phase log output validation
#  11. Gate failure after echo agent success
#  12. Merge with diverged main (rebase recovery)
#  13. Post-merge typecheck failure (auto-revert flow)
#  14. Pre-lock rebase + fast-forward merge path
#  15. Worktree and branch cleanup verification
#  16. Task unclaim → re-claim lifecycle
#  17. Database consistency after full test suite
#
# Requirements: git, sqlite3, bash
# Usage: bash tests/integration/echo-agent-lifecycle.test.sh

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

# log() used by pipeline modules — suppress until LOG is defined
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

assert_not_contains() {
  local haystack="$1" needle="$2" msg="$3"
  if echo "$haystack" | grep -qF "$needle"; then fail "$msg (should not contain '$needle')"
  else pass "$msg"; fi
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

assert_file_exists() {
  local path="$1" msg="$2"
  if [ -f "$path" ]; then pass "$msg"
  else fail "$msg (file not found: $path)"; fi
}

assert_file_not_exists() {
  local path="$1" msg="$2"
  if [ ! -f "$path" ]; then pass "$msg"
  else fail "$msg (file should not exist: $path)"; fi
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
  rm -rf "/tmp/skynet-test-echo-$$"* 2>/dev/null || true
  rm -rf "$TMPDIR_ROOT"
}
trap cleanup EXIT

echo ""
_tlog "=== Setup: creating isolated git environment for echo agent lifecycle ==="

# Create bare remote and clone as project
git init --bare "$TMPDIR_ROOT/remote.git" >/dev/null 2>&1
git -C "$TMPDIR_ROOT/remote.git" symbolic-ref HEAD refs/heads/main
git clone "$TMPDIR_ROOT/remote.git" "$TMPDIR_ROOT/project" >/dev/null 2>&1

cd "$TMPDIR_ROOT/project"
git checkout -b main 2>/dev/null || true
git config user.email "test@echo-lifecycle.test"
git config user.name "Echo Lifecycle Test"
echo "# Echo Agent Lifecycle Test" > README.md
git add README.md
git commit -m "Initial commit" >/dev/null 2>&1
git push -u origin main >/dev/null 2>&1

# Create .dev/ and config
mkdir -p "$TMPDIR_ROOT/project/.dev"

cat > "$TMPDIR_ROOT/project/.dev/skynet.config.sh" <<CONF
export SKYNET_PROJECT_NAME="test-echo"
export SKYNET_PROJECT_DIR="$TMPDIR_ROOT/project"
export SKYNET_DEV_DIR="$TMPDIR_ROOT/project/.dev"
export SKYNET_LOCK_PREFIX="/tmp/skynet-test-echo-$$"
export SKYNET_MAIN_BRANCH="main"
export SKYNET_MAX_WORKERS=2
export SKYNET_MAX_FIXERS=1
export SKYNET_MAX_TASKS_PER_RUN=1
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
export SKYNET_PROJECT_NAME="test-echo"
export SKYNET_LOCK_PREFIX="/tmp/skynet-test-echo-$$"
export SKYNET_MAIN_BRANCH="main"
export SKYNET_MAX_WORKERS=2
export SKYNET_MAX_FIXERS=1
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

# Derived paths (match what _config.sh would set)
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

# Unit separator for parsing db output
SEP=$'\x1f'

# Log file
LOG="$TMPDIR_ROOT/test-echo-lifecycle.log"
: > "$LOG"

# Redirect pipeline log() to the file
log() { echo "[$(date '+%H:%M:%S')] $*" >> "$LOG"; }

# Stub tg() and emit_event()
tg() { :; }
emit_event() { :; }

# Define git helpers that _merge.sh expects
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

pass "Setup: isolated echo agent lifecycle test environment created"

# ============================================================
# TEST 1: Echo agent plugin interface
# ============================================================

echo ""
_tlog "=== Test 1: Echo agent plugin interface (agent_check / agent_run) ==="

# agent_check should always return 0 (no external dependencies)
agent_check
assert_eq "$?" "0" "plugin: agent_check returns 0 (always available)"

# agent_check should be a function (not an external command)
if declare -f agent_check >/dev/null 2>&1; then
  pass "plugin: agent_check is a shell function"
else
  fail "plugin: agent_check should be a shell function"
fi

# agent_run should also be a function
if declare -f agent_run >/dev/null 2>&1; then
  pass "plugin: agent_run is a shell function"
else
  fail "plugin: agent_run should be a shell function"
fi

# ============================================================
# TEST 2: Echo agent prompt parsing and slug generation
# ============================================================

echo ""
_tlog "=== Test 2: Prompt parsing and slug generation ==="

cd "$PROJECT_DIR"

# Test direct title (no "Your task:" prefix)
BRANCH_T2A="dev/slug-direct-title"
WORKTREE_DIR="$SKYNET_WORKTREE_BASE/w-t2a"
cleanup_worktree 2>/dev/null || true
git worktree add "$WORKTREE_DIR" -b "$BRANCH_T2A" "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1

(
  cd "$WORKTREE_DIR"
  git config user.email "test@echo-lifecycle.test"
  git config user.name "Echo Lifecycle Test"
  agent_run "Add user auth endpoint" "$LOG"
)
_rc=$?
assert_eq "$_rc" "0" "slug: direct title prompt succeeds"
assert_file_exists "$WORKTREE_DIR/echo-agent-add-user-auth-endpoint.md" "slug: correct file from direct title"

cleanup_worktree "$BRANCH_T2A"

# Test "Your task:" prefix
BRANCH_T2B="dev/slug-your-task-prefix"
WORKTREE_DIR="$SKYNET_WORKTREE_BASE/w-t2b"
cleanup_worktree 2>/dev/null || true
cd "$PROJECT_DIR"
git worktree add "$WORKTREE_DIR" -b "$BRANCH_T2B" "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1

(
  cd "$WORKTREE_DIR"
  git config user.email "test@echo-lifecycle.test"
  git config user.name "Echo Lifecycle Test"
  agent_run "Your task: Fix login redirect bug" "$LOG"
)
_rc=$?
assert_eq "$_rc" "0" "slug: 'Your task:' prefix prompt succeeds"
assert_file_exists "$WORKTREE_DIR/echo-agent-fix-login-redirect-bug.md" "slug: correct file from 'Your task:' prefix"

# Verify file content uses extracted title (not raw prompt)
CONTENT=$(cat "$WORKTREE_DIR/echo-agent-fix-login-redirect-bug.md")
assert_contains "$CONTENT" "Fix login redirect bug" "slug: file contains extracted task title"

cleanup_worktree "$BRANCH_T2B"

# Test slug truncation (title > 40 chars)
BRANCH_T2C="dev/slug-long-title"
WORKTREE_DIR="$SKYNET_WORKTREE_BASE/w-t2c"
cleanup_worktree 2>/dev/null || true
cd "$PROJECT_DIR"
git worktree add "$WORKTREE_DIR" -b "$BRANCH_T2C" "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1

(
  cd "$WORKTREE_DIR"
  git config user.email "test@echo-lifecycle.test"
  git config user.name "Echo Lifecycle Test"
  agent_run "Implement a very long task title that exceeds the forty character slug limit" "$LOG"
)
_rc=$?
assert_eq "$_rc" "0" "slug: long title truncation succeeds"

# Verify the file was created (slug is truncated at 40 chars before conversion)
LONG_FILE=$(cd "$WORKTREE_DIR" && ls echo-agent-*.md 2>/dev/null | head -1)
assert_not_empty "$LONG_FILE" "slug: file created for long title"

cleanup_worktree "$BRANCH_T2C"

# ============================================================
# TEST 3: Placeholder file content validation
# ============================================================

echo ""
_tlog "=== Test 3: Placeholder file content validation ==="

_reset_test_state

BRANCH_T3="dev/placeholder-content"
WORKTREE_DIR="$SKYNET_WORKTREE_BASE/w-t3"
cleanup_worktree 2>/dev/null || true
cd "$PROJECT_DIR"
git worktree add "$WORKTREE_DIR" -b "$BRANCH_T3" "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1

(
  cd "$WORKTREE_DIR"
  git config user.email "test@echo-lifecycle.test"
  git config user.name "Echo Lifecycle Test"
  agent_run "Build search component" "$LOG"
)

PLACEHOLDER="$WORKTREE_DIR/echo-agent-build-search-component.md"
assert_file_exists "$PLACEHOLDER" "content: placeholder file exists"

CONTENT=$(cat "$PLACEHOLDER")
assert_contains "$CONTENT" "Echo Agent" "content: has Echo Agent header"
assert_contains "$CONTENT" "Dry Run Placeholder" "content: identifies as dry-run"
assert_contains "$CONTENT" "Build search component" "content: contains task title"
assert_contains "$CONTENT" "echo (dry-run)" "content: agent type is echo"
assert_contains "$CONTENT" "Task Description" "content: has task description section"

# Verify commit message format
COMMIT_MSG=$(cd "$WORKTREE_DIR" && git log -1 --format=%s)
assert_contains "$COMMIT_MSG" "echo-agent:" "content: commit has echo-agent: prefix"
assert_contains "$COMMIT_MSG" "dry-run placeholder" "content: commit mentions dry-run"

cleanup_worktree "$BRANCH_T3"

# ============================================================
# TEST 4: SKYNET_ECHO_FAIL failure simulation
# ============================================================

echo ""
_tlog "=== Test 4: SKYNET_ECHO_FAIL failure simulation ==="

_reset_test_state

BRANCH_T4="dev/echo-fail-sim"
WORKTREE_DIR="$SKYNET_WORKTREE_BASE/w-t4"
cleanup_worktree 2>/dev/null || true
cd "$PROJECT_DIR"
git worktree add "$WORKTREE_DIR" -b "$BRANCH_T4" "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1

# Run with SKYNET_ECHO_FAIL=1
FAIL_LOG="$TMPDIR_ROOT/echo-fail.log"
(
  cd "$WORKTREE_DIR"
  git config user.email "test@echo-lifecycle.test"
  git config user.name "Echo Lifecycle Test"
  SKYNET_ECHO_FAIL=1 agent_run "Failing task test" "$FAIL_LOG"
) && _rc=0 || _rc=$?

assert_gt "$_rc" "0" "echo-fail: returns non-zero when SKYNET_ECHO_FAIL=1"

# Verify log shows failure
FAIL_LOG_CONTENT=$(cat "$FAIL_LOG" 2>/dev/null || echo "")
assert_contains "$FAIL_LOG_CONTENT" "FAILURE" "echo-fail: log records FAILURE"
assert_contains "$FAIL_LOG_CONTENT" "ABORTED" "echo-fail: log records ABORTED"

# No placeholder file should be created on failure
FAIL_FILES=$(cd "$WORKTREE_DIR" && ls echo-agent-*.md 2>/dev/null | wc -l | tr -d ' ')
assert_eq "$FAIL_FILES" "0" "echo-fail: no placeholder file created on failure"

# No commit should be made on failure
FAIL_COMMITS=$(cd "$WORKTREE_DIR" && git log --oneline "$SKYNET_MAIN_BRANCH"..HEAD 2>/dev/null | wc -l | tr -d ' ')
assert_eq "$FAIL_COMMITS" "0" "echo-fail: no commits on failure"

cleanup_worktree "$BRANCH_T4"

# ============================================================
# TEST 5: SKYNET_ECHO_DELAY work simulation
# ============================================================

echo ""
_tlog "=== Test 5: SKYNET_ECHO_DELAY work simulation ==="

_reset_test_state

BRANCH_T5="dev/echo-delay-sim"
WORKTREE_DIR="$SKYNET_WORKTREE_BASE/w-t5"
cleanup_worktree 2>/dev/null || true
cd "$PROJECT_DIR"
git worktree add "$WORKTREE_DIR" -b "$BRANCH_T5" "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1

DELAY_LOG="$TMPDIR_ROOT/echo-delay.log"
START_TIME=$(date +%s)
(
  cd "$WORKTREE_DIR"
  git config user.email "test@echo-lifecycle.test"
  git config user.name "Echo Lifecycle Test"
  SKYNET_ECHO_DELAY=1 agent_run "Delayed task test" "$DELAY_LOG"
)
_rc=$?
END_TIME=$(date +%s)
ELAPSED=$((END_TIME - START_TIME))

assert_eq "$_rc" "0" "echo-delay: succeeds with delay"
assert_gt "$ELAPSED" "0" "echo-delay: took at least 1 second"

# Verify log mentions the delay
DELAY_LOG_CONTENT=$(cat "$DELAY_LOG" 2>/dev/null || echo "")
assert_contains "$DELAY_LOG_CONTENT" "simulating work" "echo-delay: log mentions simulating work"

# File should still be created
assert_file_exists "$WORKTREE_DIR/echo-agent-delayed-task-test.md" "echo-delay: placeholder created despite delay"

cleanup_worktree "$BRANCH_T5"

# ============================================================
# TEST 6: Git precondition validation
# ============================================================

echo ""
_tlog "=== Test 6: Git precondition validation ==="

# Run agent outside a git repo — should fail
NON_GIT_DIR="$TMPDIR_ROOT/not-a-repo"
mkdir -p "$NON_GIT_DIR"
PRECOND_LOG="$TMPDIR_ROOT/echo-precond.log"

(
  cd "$NON_GIT_DIR"
  agent_run "Should fail outside git" "$PRECOND_LOG"
) && _rc=0 || _rc=$?

assert_gt "$_rc" "0" "precondition: fails outside git repo"

PRECOND_CONTENT=$(cat "$PRECOND_LOG" 2>/dev/null || echo "")
assert_contains "$PRECOND_CONTENT" "not inside a git work tree" "precondition: log explains failure"

# ============================================================
# TEST 7: Full lifecycle — claim → worktree → echo agent → gates → merge
# ============================================================

echo ""
_tlog "=== Test 7: Full lifecycle — claim → worktree → echo agent → gates → merge ==="

_reset_test_state
sqlite3 "$DB_PATH" "DELETE FROM tasks;"
export SKYNET_GATE_1="true"

# Phase 1: Seed task
T7_ID=$(db_add_task "Implement search feature" "FEAT" "Full lifecycle test" "top")
assert_not_empty "$T7_ID" "lifecycle: task seeded in DB"

STATUS=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$T7_ID;")
assert_eq "$STATUS" "pending" "lifecycle: initial status is pending"

# Phase 2: Claim task
CLAIM7=$(db_claim_next_task 1)
assert_not_empty "$CLAIM7" "lifecycle: claim returned result"

CLAIM7_ID=$(echo "$CLAIM7" | cut -d"$SEP" -f1)
CLAIM7_TITLE=$(echo "$CLAIM7" | cut -d"$SEP" -f2)
assert_eq "$CLAIM7_ID" "$T7_ID" "lifecycle: claimed correct task ID"
assert_eq "$CLAIM7_TITLE" "Implement search feature" "lifecycle: claimed correct title"

STATUS=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$T7_ID;")
assert_eq "$STATUS" "claimed" "lifecycle: status transitions to claimed"

WORKER_ID=$(sqlite3 "$DB_PATH" "SELECT worker_id FROM tasks WHERE id=$T7_ID;")
assert_eq "$WORKER_ID" "1" "lifecycle: worker_id recorded"

# Phase 3: Create worktree
BRANCH_7="dev/implement-search-feature"
WORKTREE_DIR="$SKYNET_WORKTREE_BASE/w-lifecycle"
cleanup_worktree 2>/dev/null || true
cd "$PROJECT_DIR"
git worktree add "$WORKTREE_DIR" -b "$BRANCH_7" "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1

if [ -d "$WORKTREE_DIR" ]; then
  pass "lifecycle: worktree created"
else
  fail "lifecycle: worktree not created"
fi

# Verify feature branch exists
if git show-ref --verify --quiet "refs/heads/$BRANCH_7" 2>/dev/null; then
  pass "lifecycle: feature branch created"
else
  fail "lifecycle: feature branch not created"
fi

# Phase 4: Run echo agent
db_set_worker_status 1 "dev" "in_progress" "$T7_ID" "Implement search feature" "$BRANCH_7" 2>/dev/null || true

(
  cd "$WORKTREE_DIR"
  git config user.email "test@echo-lifecycle.test"
  git config user.name "Echo Lifecycle Test"
  agent_run "Implement search feature" "$LOG"
)
_agent_rc=$?
assert_eq "$_agent_rc" "0" "lifecycle: echo agent succeeded"

# Verify echo agent artifacts in worktree
assert_file_exists "$WORKTREE_DIR/echo-agent-implement-search-feature.md" "lifecycle: echo agent placeholder created"
AGENT_COMMITS=$(cd "$WORKTREE_DIR" && git log --oneline "$SKYNET_MAIN_BRANCH"..HEAD 2>/dev/null | wc -l | tr -d ' ')
assert_gt "$AGENT_COMMITS" "0" "lifecycle: echo agent committed changes"

# Phase 5: Quality gates
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
assert_empty "$_gate_failed" "lifecycle: quality gates passed"

# Phase 6: Merge to main
_mrc=0
run_merge "$BRANCH_7" "$WORKTREE_DIR" "$LOG" "false" || _mrc=$?
assert_eq "$_mrc" "0" "lifecycle: merge to main succeeded (rc=0)"

# Phase 7: Verify merge artifacts on main
cd "$PROJECT_DIR"
git checkout "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1 || true

MAIN_LOG=$(git log --oneline -5)
assert_contains "$MAIN_LOG" "echo-agent" "lifecycle: echo agent commit on main"

assert_file_exists "$PROJECT_DIR/echo-agent-implement-search-feature.md" "lifecycle: placeholder file on main after merge"

# Phase 8: Complete task in DB
db_complete_task "$CLAIM7_ID" "$BRANCH_7" "1m" 60 "success" 2>/dev/null || true
STATUS=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$T7_ID;")
assert_eq "$STATUS" "completed" "lifecycle: final status is completed"

# Phase 9: Verify cleanup
# Worktree should be removed by do_merge_to_main
if [ -d "$WORKTREE_DIR" ]; then
  # do_merge_to_main cleans up worktree dir — if it still exists, that's fine
  # (test cleanup_worktree handles it)
  cleanup_worktree
fi

# Feature branch should be deleted by do_merge_to_main
if git show-ref --verify --quiet "refs/heads/$BRANCH_7" 2>/dev/null; then
  fail "lifecycle: feature branch should be deleted after merge"
else
  pass "lifecycle: feature branch cleaned up after merge"
fi

# Worker idle
db_set_worker_idle 1 "lifecycle test complete" 2>/dev/null || true
WSTAT=$(db_get_worker_status 1)
assert_contains "$WSTAT" "idle" "lifecycle: worker set to idle after completion"

# ============================================================
# TEST 8: Agent failure → DB failed state → fixer retry
# ============================================================

echo ""
_tlog "=== Test 8: Agent failure → DB failed state → fixer retry ==="

_reset_test_state
sqlite3 "$DB_PATH" "DELETE FROM tasks;"

# Seed a task
T8_ID=$(db_add_task "Buggy feature implementation" "FIX" "" "top")
assert_not_empty "$T8_ID" "fixer-retry: task seeded"

# Claim it
CLAIM8=$(db_claim_next_task 1)
CLAIM8_ID=$(echo "$CLAIM8" | cut -d"$SEP" -f1)
assert_eq "$CLAIM8_ID" "$T8_ID" "fixer-retry: task claimed"

# Create worktree and run failing agent
BRANCH_8="dev/buggy-feature"
WORKTREE_DIR="$SKYNET_WORKTREE_BASE/w-fixer"
cleanup_worktree 2>/dev/null || true
cd "$PROJECT_DIR"
git worktree add "$WORKTREE_DIR" -b "$BRANCH_8" "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1

(
  cd "$WORKTREE_DIR"
  git config user.email "test@echo-lifecycle.test"
  git config user.name "Echo Lifecycle Test"
  SKYNET_ECHO_FAIL=1 agent_run "Buggy feature implementation" "$LOG"
) && _rc=0 || _rc=$?

assert_gt "$_rc" "0" "fixer-retry: first agent attempt fails"

# Simulate dev-worker failure handling
cleanup_worktree "$BRANCH_8"
db_fail_task "$CLAIM8_ID" "$BRANCH_8" "agent exit code $_rc"

STATUS=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$T8_ID;")
assert_eq "$STATUS" "failed" "fixer-retry: task marked failed after agent failure"

ERROR=$(sqlite3 "$DB_PATH" "SELECT error FROM tasks WHERE id=$T8_ID;")
assert_contains "$ERROR" "agent exit code" "fixer-retry: error message stored"

# Simulate task-fixer claiming the failed task
# (task-fixer uses db_claim_next_failed_task which sets status to fixing-N)
sqlite3 "$DB_PATH" "UPDATE tasks SET status='fixing-1', fixer_id=1 WHERE id=$T8_ID;"
STATUS=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$T8_ID;")
assert_eq "$STATUS" "fixing-1" "fixer-retry: status set to fixing-1"

# Task-fixer runs echo agent successfully this time (no SKYNET_ECHO_FAIL)
BRANCH_8_FIX="dev/buggy-feature-fix"
WORKTREE_DIR="$SKYNET_WORKTREE_BASE/w-fixer"
cleanup_worktree 2>/dev/null || true
cd "$PROJECT_DIR"
git worktree add "$WORKTREE_DIR" -b "$BRANCH_8_FIX" "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1

(
  cd "$WORKTREE_DIR"
  git config user.email "test@echo-lifecycle.test"
  git config user.name "Echo Lifecycle Test"
  agent_run "Buggy feature implementation" "$LOG"
)
_rc=$?
assert_eq "$_rc" "0" "fixer-retry: second agent attempt succeeds"

# Merge the fix
_mrc=0
run_merge "$BRANCH_8_FIX" "$WORKTREE_DIR" "$LOG" "false" || _mrc=$?
assert_eq "$_mrc" "0" "fixer-retry: merge succeeds on retry"

# Complete task via db_fix_task (what task-fixer.sh actually calls)
db_fix_task "$T8_ID" "$BRANCH_8_FIX" 2 "" 2>/dev/null || true
STATUS=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$T8_ID;")
assert_eq "$STATUS" "fixed" "fixer-retry: task marked fixed after fixer retry"

cd "$PROJECT_DIR"
git checkout "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1 || true

# ============================================================
# TEST 9: Sequential multi-task lifecycle with state export
# ============================================================

echo ""
_tlog "=== Test 9: Sequential multi-task lifecycle with state export ==="

_reset_test_state
sqlite3 "$DB_PATH" "DELETE FROM tasks;"

# Seed 3 tasks
T9A_ID=$(db_add_task "Create API routes" "FEAT" "" "top")
T9B_ID=$(db_add_task "Add unit tests" "TEST" "" "bottom")
T9C_ID=$(db_add_task "Update documentation" "CHORE" "" "bottom")

# Verify all pending
for _tid in $T9A_ID $T9B_ID $T9C_ID; do
  _s=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$_tid;")
  assert_eq "$_s" "pending" "multi: task $_tid starts as pending"
done

COMPLETED_COUNT=0

for iter in 1 2 3; do
  cd "$PROJECT_DIR"
  git checkout "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1 || true

  _claim=$(db_claim_next_task 1)
  [ -z "$_claim" ] && break
  _cid=$(echo "$_claim" | cut -d"$SEP" -f1)
  _ctitle=$(echo "$_claim" | cut -d"$SEP" -f2)
  _branch="dev/$(echo "$_ctitle" | tr '[:upper:]' '[:lower:]' | tr -cs '[:alnum:]' '-' | sed 's/^-//;s/-$//' | head -c 30)"

  WORKTREE_DIR="$SKYNET_WORKTREE_BASE/w-multi"
  cleanup_worktree 2>/dev/null || true
  git worktree add "$WORKTREE_DIR" -b "$_branch" "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1

  (
    cd "$WORKTREE_DIR"
    git config user.email "test@echo-lifecycle.test"
    git config user.name "Echo Lifecycle Test"
    agent_run "$_ctitle" "$LOG"
  )

  _mrc=0
  run_merge "$_branch" "$WORKTREE_DIR" "$LOG" "false" || _mrc=$?

  if [ "$_mrc" -eq 0 ]; then
    db_complete_task "$_cid" "$_branch" "1m" 60 "success" 2>/dev/null || true
    COMPLETED_COUNT=$((COMPLETED_COUNT + 1))
  else
    db_fail_task "$_cid" "$_branch" "merge failed (rc=$_mrc)" 2>/dev/null || true
  fi
done

assert_eq "$COMPLETED_COUNT" "3" "multi: all 3 tasks completed"

# Verify each task is completed
for _tid in $T9A_ID $T9B_ID $T9C_ID; do
  _s=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$_tid;")
  assert_eq "$_s" "completed" "multi: task $_tid is completed"
done

# Verify main has multiple echo-agent commits
cd "$PROJECT_DIR"
git checkout "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1 || true
ECHO_COMMITS=$(git log --oneline | grep -c "echo-agent" || echo 0)
assert_gt "$ECHO_COMMITS" "2" "multi: multiple echo-agent commits on main"

# Verify state export
db_export_state_files
COMPLETED_CONTENT=$(cat "$COMPLETED" 2>/dev/null || echo "")
assert_contains "$COMPLETED_CONTENT" "Create API routes" "multi: completed.md has first task"
assert_contains "$COMPLETED_CONTENT" "Add unit tests" "multi: completed.md has second task"
assert_contains "$COMPLETED_CONTENT" "Update documentation" "multi: completed.md has third task"

# No pending or claimed tasks should remain
REMAINING=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM tasks WHERE status IN ('pending','claimed');")
assert_eq "$REMAINING" "0" "multi: no pending/claimed tasks remain"

# ============================================================
# TEST 10: Echo agent log output lifecycle phases
# ============================================================

echo ""
_tlog "=== Test 10: Echo agent log output lifecycle phases ==="

_reset_test_state

BRANCH_T10="dev/log-phases"
WORKTREE_DIR="$SKYNET_WORKTREE_BASE/w-t10"
cleanup_worktree 2>/dev/null || true
cd "$PROJECT_DIR"
git worktree add "$WORKTREE_DIR" -b "$BRANCH_T10" "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1

PHASE_LOG="$TMPDIR_ROOT/echo-phases.log"
: > "$PHASE_LOG"

(
  cd "$WORKTREE_DIR"
  git config user.email "test@echo-lifecycle.test"
  git config user.name "Echo Lifecycle Test"
  agent_run "Log phase validation" "$PHASE_LOG"
)

PHASE_CONTENT=$(cat "$PHASE_LOG" 2>/dev/null || echo "")

# Verify all lifecycle phases are logged
assert_contains "$PHASE_CONTENT" "DRY-RUN LIFECYCLE START" "phases: lifecycle start logged"
assert_contains "$PHASE_CONTENT" "phase=parse-prompt" "phases: parse-prompt phase logged"
assert_contains "$PHASE_CONTENT" "phase=validate OK" "phases: validate phase logged"
assert_contains "$PHASE_CONTENT" "phase=read-codebase" "phases: read-codebase phase logged"
assert_contains "$PHASE_CONTENT" "phase=plan-implementation" "phases: plan-implementation phase logged"
assert_contains "$PHASE_CONTENT" "phase=implement" "phases: implement phase logged"
assert_contains "$PHASE_CONTENT" "phase=quality-check" "phases: quality-check phase logged"
assert_contains "$PHASE_CONTENT" "phase=commit OK" "phases: commit phase logged"
assert_contains "$PHASE_CONTENT" "DRY-RUN LIFECYCLE COMPLETE" "phases: lifecycle complete logged"

cleanup_worktree "$BRANCH_T10"

# ============================================================
# TEST 11: Gate failure after echo agent success
# ============================================================

echo ""
_tlog "=== Test 11: Gate failure after echo agent success ==="

_reset_test_state

T11_ID=$(db_add_task "Gate failure test" "FEAT" "" "top")
CLAIM11=$(db_claim_next_task 1)
CLAIM11_ID=$(echo "$CLAIM11" | cut -d"$SEP" -f1)

BRANCH_11="dev/gate-failure"
WORKTREE_DIR="$SKYNET_WORKTREE_BASE/w-t11"
cleanup_worktree 2>/dev/null || true
cd "$PROJECT_DIR"
git worktree add "$WORKTREE_DIR" -b "$BRANCH_11" "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1

# Echo agent succeeds
(
  cd "$WORKTREE_DIR"
  git config user.email "test@echo-lifecycle.test"
  git config user.name "Echo Lifecycle Test"
  agent_run "Gate failure test" "$LOG"
)
_agent_rc=$?
assert_eq "$_agent_rc" "0" "gate-fail: echo agent succeeds"

# But the gate fails
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
assert_eq "$_gate_failed" "false" "gate-fail: gate correctly detected as failed"

# Task should be marked failed (simulating dev-worker behavior)
cleanup_worktree "$BRANCH_11"
db_fail_task "$CLAIM11_ID" "$BRANCH_11" "gate 1 failed: false"

STATUS=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$T11_ID;")
assert_eq "$STATUS" "failed" "gate-fail: task marked failed after gate failure"

ERROR=$(sqlite3 "$DB_PATH" "SELECT error FROM tasks WHERE id=$T11_ID;")
assert_contains "$ERROR" "gate 1 failed" "gate-fail: error message records gate failure"

# Restore passing gate
export SKYNET_GATE_1="true"

# ============================================================
# TEST 12: Merge with diverged main (rebase recovery)
# ============================================================

echo ""
_tlog "=== Test 12: Merge with diverged main (rebase recovery) ==="

_reset_test_state
sqlite3 "$DB_PATH" "DELETE FROM tasks;"

# Seed and claim task
T12_ID=$(db_add_task "Feature on stale branch" "FEAT" "" "top")
CLAIM12=$(db_claim_next_task 1)
CLAIM12_ID=$(echo "$CLAIM12" | cut -d"$SEP" -f1)

# Create worktree and run echo agent
BRANCH_12="dev/feature-stale-branch"
WORKTREE_DIR="$SKYNET_WORKTREE_BASE/w-t12"
cleanup_worktree 2>/dev/null || true
cd "$PROJECT_DIR"
git worktree add "$WORKTREE_DIR" -b "$BRANCH_12" "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1

(
  cd "$WORKTREE_DIR"
  git config user.email "test@echo-lifecycle.test"
  git config user.name "Echo Lifecycle Test"
  agent_run "Feature on stale branch" "$LOG"
)
_rc=$?
assert_eq "$_rc" "0" "diverged-main: echo agent succeeded"

# Now advance main independently (simulate another worker merging while we worked)
cd "$PROJECT_DIR"
git checkout "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1
echo "# Concurrent change" > concurrent-change.md
git add concurrent-change.md
git commit -m "concurrent: another worker's commit" >/dev/null 2>&1
git push origin "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1

# Merge should succeed via rebase recovery or 3-way merge
_mrc=0
run_merge "$BRANCH_12" "$WORKTREE_DIR" "$LOG" "false" || _mrc=$?
assert_eq "$_mrc" "0" "diverged-main: merge succeeds despite diverged main"

# Verify both commits are on main
cd "$PROJECT_DIR"
git checkout "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1
MAIN_LOG=$(git log --oneline -10)
assert_contains "$MAIN_LOG" "concurrent" "diverged-main: concurrent commit preserved"
assert_contains "$MAIN_LOG" "echo-agent" "diverged-main: echo agent commit merged"

# Both files should be on main
assert_file_exists "$PROJECT_DIR/concurrent-change.md" "diverged-main: concurrent file on main"
assert_file_exists "$PROJECT_DIR/echo-agent-feature-on-stale-branch.md" "diverged-main: placeholder on main"

db_complete_task "$CLAIM12_ID" "$BRANCH_12" "1m" 60 "success" 2>/dev/null || true

# ============================================================
# TEST 13: Post-merge typecheck failure (auto-revert)
# ============================================================

echo ""
_tlog "=== Test 13: Post-merge typecheck failure (auto-revert) ==="

_reset_test_state
sqlite3 "$DB_PATH" "DELETE FROM tasks;"

T13_ID=$(db_add_task "Bad code that breaks typecheck" "FEAT" "" "top")
CLAIM13=$(db_claim_next_task 1)
CLAIM13_ID=$(echo "$CLAIM13" | cut -d"$SEP" -f1)

BRANCH_13="dev/bad-typecheck"
WORKTREE_DIR="$SKYNET_WORKTREE_BASE/w-t13"
cleanup_worktree 2>/dev/null || true
cd "$PROJECT_DIR"
git worktree add "$WORKTREE_DIR" -b "$BRANCH_13" "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1

(
  cd "$WORKTREE_DIR"
  git config user.email "test@echo-lifecycle.test"
  git config user.name "Echo Lifecycle Test"
  agent_run "Bad code that breaks typecheck" "$LOG"
)

# Enable post-merge typecheck with a command that fails
export SKYNET_POST_MERGE_TYPECHECK="true"
export SKYNET_TYPECHECK_CMD="false"

# Merge will succeed but typecheck will fail → auto-revert → return code 2
_mrc=0
run_merge "$BRANCH_13" "$WORKTREE_DIR" "$LOG" "false" || _mrc=$?
assert_eq "$_mrc" "2" "typecheck-fail: returns rc=2 (typecheck failed, reverted)"

# The echo agent's placeholder should NOT be on main (reverted)
cd "$PROJECT_DIR"
git checkout "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1

# Main should have a revert commit
REVERT_LOG=$(git log --oneline -5)
assert_contains "$REVERT_LOG" "revert" "typecheck-fail: revert commit on main"

# Placeholder file should be gone (reverted)
assert_file_not_exists "$PROJECT_DIR/echo-agent-bad-code-that-breaks-typecheck.md" \
  "typecheck-fail: placeholder reverted from main"

# Typecheck duration file should exist (written even on failure for future TTL)
assert_file_exists "$DEV_DIR/typecheck-duration" "typecheck-fail: typecheck-duration written"

# Task should be marked failed
db_fail_task "$CLAIM13_ID" "$BRANCH_13" "post-merge typecheck failed (rc=2)" 2>/dev/null || true
STATUS=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$T13_ID;")
assert_eq "$STATUS" "failed" "typecheck-fail: task marked failed after typecheck revert"

# Restore passing typecheck/gates
export SKYNET_POST_MERGE_TYPECHECK="false"
export SKYNET_TYPECHECK_CMD="true"

# ============================================================
# TEST 14: Pre-lock rebase + fast-forward merge
# ============================================================

echo ""
_tlog "=== Test 14: Pre-lock rebase + fast-forward merge ==="

_reset_test_state
sqlite3 "$DB_PATH" "DELETE FROM tasks;"

T14_ID=$(db_add_task "Fast forward feature" "FEAT" "" "top")
CLAIM14=$(db_claim_next_task 1)
CLAIM14_ID=$(echo "$CLAIM14" | cut -d"$SEP" -f1)

BRANCH_14="dev/fast-forward-feature"
WORKTREE_DIR="$SKYNET_WORKTREE_BASE/w-t14"
cleanup_worktree 2>/dev/null || true
cd "$PROJECT_DIR"
git worktree add "$WORKTREE_DIR" -b "$BRANCH_14" "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1

(
  cd "$WORKTREE_DIR"
  git config user.email "test@echo-lifecycle.test"
  git config user.name "Echo Lifecycle Test"
  agent_run "Fast forward feature" "$LOG"
)

# Simulate pre-lock rebase in worktree (like dev-worker does before merge)
(
  cd "$WORKTREE_DIR"
  git fetch origin "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1
  git rebase "origin/$SKYNET_MAIN_BRANCH" >/dev/null 2>&1
) && _rebase_ok=true || _rebase_ok=false

assert_eq "$_rebase_ok" "true" "pre-lock-rebase: rebase succeeded in worktree"

# Merge with pre_lock_rebased=true → should attempt fast-forward
_mrc=0
run_merge "$BRANCH_14" "$WORKTREE_DIR" "$LOG" "true" || _mrc=$?
assert_eq "$_mrc" "0" "pre-lock-rebase: fast-forward merge succeeded"

# Check log for fast-forward confirmation
LOG_CONTENT=$(cat "$LOG" 2>/dev/null || echo "")
assert_contains "$LOG_CONTENT" "Fast-forward merge succeeded" "pre-lock-rebase: log confirms fast-forward"

# Verify file on main
cd "$PROJECT_DIR"
git checkout "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1
assert_file_exists "$PROJECT_DIR/echo-agent-fast-forward-feature.md" \
  "pre-lock-rebase: placeholder on main after ff merge"

db_complete_task "$CLAIM14_ID" "$BRANCH_14" "1m" 60 "success" 2>/dev/null || true

# ============================================================
# TEST 15: Worktree and branch cleanup verification
# ============================================================

echo ""
_tlog "=== Test 15: Worktree and branch cleanup verification ==="

_reset_test_state
sqlite3 "$DB_PATH" "DELETE FROM tasks;"

T15_ID=$(db_add_task "Cleanup verification task" "TEST" "" "top")
CLAIM15=$(db_claim_next_task 1)
CLAIM15_ID=$(echo "$CLAIM15" | cut -d"$SEP" -f1)

BRANCH_15="dev/cleanup-verification"
WORKTREE_DIR="$SKYNET_WORKTREE_BASE/w-t15"
cleanup_worktree 2>/dev/null || true
cd "$PROJECT_DIR"
git worktree add "$WORKTREE_DIR" -b "$BRANCH_15" "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1

# Verify worktree exists before merge
WLIST_BEFORE=$(git worktree list 2>/dev/null)
assert_contains "$WLIST_BEFORE" "w-t15" "cleanup: worktree visible in git worktree list before merge"

if git show-ref --verify --quiet "refs/heads/$BRANCH_15" 2>/dev/null; then
  pass "cleanup: feature branch exists before merge"
else
  fail "cleanup: feature branch should exist before merge"
fi

# Run echo agent
(
  cd "$WORKTREE_DIR"
  git config user.email "test@echo-lifecycle.test"
  git config user.name "Echo Lifecycle Test"
  agent_run "Cleanup verification task" "$LOG"
)

# Merge (do_merge_to_main cleans worktree and deletes branch)
_mrc=0
run_merge "$BRANCH_15" "$WORKTREE_DIR" "$LOG" "false" || _mrc=$?
assert_eq "$_mrc" "0" "cleanup: merge succeeded"

# Verify worktree is gone
cd "$PROJECT_DIR"
if [ -d "$WORKTREE_DIR" ]; then
  fail "cleanup: worktree directory should be removed after merge"
else
  pass "cleanup: worktree directory removed after merge"
fi

WLIST_AFTER=$(git worktree list 2>/dev/null)
assert_not_contains "$WLIST_AFTER" "w-t15" "cleanup: worktree not in git worktree list after merge"

# Verify feature branch is deleted
if git show-ref --verify --quiet "refs/heads/$BRANCH_15" 2>/dev/null; then
  fail "cleanup: feature branch should be deleted after merge"
else
  pass "cleanup: feature branch deleted after merge"
fi

# Verify no stale worktree refs
PRUNE_COUNT=$(git worktree list --porcelain 2>/dev/null | grep -c "prunable" 2>/dev/null || true)
PRUNE_COUNT=$(echo "$PRUNE_COUNT" | tr -d '[:space:]')
[ -z "$PRUNE_COUNT" ] && PRUNE_COUNT="0"
assert_eq "$PRUNE_COUNT" "0" "cleanup: no prunable worktrees remain"

db_complete_task "$CLAIM15_ID" "$BRANCH_15" "1m" 60 "success" 2>/dev/null || true

# ============================================================
# TEST 16: Task unclaim → re-claim lifecycle
# ============================================================

echo ""
_tlog "=== Test 16: Task unclaim → re-claim lifecycle ==="

_reset_test_state
sqlite3 "$DB_PATH" "DELETE FROM tasks;"

T16_ID=$(db_add_task "Retriable task" "FEAT" "" "top")
assert_not_empty "$T16_ID" "unclaim: task seeded"

# Claim task (worker 1)
CLAIM16=$(db_claim_next_task 1)
CLAIM16_ID=$(echo "$CLAIM16" | cut -d"$SEP" -f1)
assert_eq "$CLAIM16_ID" "$T16_ID" "unclaim: task claimed by worker 1"

STATUS=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$T16_ID;")
assert_eq "$STATUS" "claimed" "unclaim: status is claimed"

# Simulate worker encountering issue and unclaiming
db_unclaim_task "$T16_ID"

STATUS=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$T16_ID;")
assert_eq "$STATUS" "pending" "unclaim: status reverts to pending after unclaim"

WORKER_ID=$(sqlite3 "$DB_PATH" "SELECT worker_id FROM tasks WHERE id=$T16_ID;")
# worker_id should be cleared (NULL → empty string in sqlite3 output)
if [ -z "$WORKER_ID" ] || [ "$WORKER_ID" = "" ]; then
  pass "unclaim: worker_id cleared after unclaim"
else
  fail "unclaim: worker_id should be cleared (got '$WORKER_ID')"
fi

# Re-claim by worker 2
CLAIM16B=$(db_claim_next_task 2)
CLAIM16B_ID=$(echo "$CLAIM16B" | cut -d"$SEP" -f1)
assert_eq "$CLAIM16B_ID" "$T16_ID" "unclaim: same task re-claimed by worker 2"

STATUS=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$T16_ID;")
assert_eq "$STATUS" "claimed" "unclaim: status is claimed after re-claim"

WORKER_ID=$(sqlite3 "$DB_PATH" "SELECT worker_id FROM tasks WHERE id=$T16_ID;")
assert_eq "$WORKER_ID" "2" "unclaim: worker_id is 2 after re-claim"

# Complete the lifecycle with the re-claimed task
BRANCH_16="dev/retriable-task"
WORKTREE_DIR="$SKYNET_WORKTREE_BASE/w-t16"
cleanup_worktree 2>/dev/null || true
cd "$PROJECT_DIR"
git worktree add "$WORKTREE_DIR" -b "$BRANCH_16" "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1

(
  cd "$WORKTREE_DIR"
  git config user.email "test@echo-lifecycle.test"
  git config user.name "Echo Lifecycle Test"
  agent_run "Retriable task" "$LOG"
)

_mrc=0
run_merge "$BRANCH_16" "$WORKTREE_DIR" "$LOG" "false" || _mrc=$?
assert_eq "$_mrc" "0" "unclaim: merge succeeds for re-claimed task"

db_complete_task "$CLAIM16B_ID" "$BRANCH_16" "1m" 60 "success" 2>/dev/null || true
STATUS=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$T16_ID;")
assert_eq "$STATUS" "completed" "unclaim: re-claimed task completed successfully"

# ============================================================
# TEST 17: Database consistency after full test suite
# ============================================================

echo ""
_tlog "=== Test 17: Database consistency after full test suite ==="

TOTAL_COMPLETED=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM tasks WHERE status='completed';")
TOTAL_FAILED=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM tasks WHERE status='failed';")
TOTAL_PENDING=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM tasks WHERE status='pending';")
TOTAL_CLAIMED=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM tasks WHERE status='claimed';")

# Accumulated completed: Test 12 (1) + Test 14 (1) + Test 15 (1) + Test 16 (1) = 4
# (Tests 9, 11 run before and each clears DB; tests 12-16 each clear DB too)
# Last DB clear was Test 16 → 1 completed
# Actually each test does sqlite3 "$DB_PATH" "DELETE FROM tasks;" so only last batch counts.
# Test 16 clears, adds 1, completes 1 → 1 completed, 0 failed
assert_eq "$TOTAL_COMPLETED" "1" "db-consistency: completed tasks from last test batch"

# Everything should be resolved
assert_eq "$TOTAL_PENDING" "0" "db-consistency: no pending tasks"
assert_eq "$TOTAL_CLAIMED" "0" "db-consistency: no orphaned claimed tasks"

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
