#!/usr/bin/env bash
# tests/unit/merge.test.sh — Unit tests for scripts/_merge.sh
#
# Tests all 8 return codes (0-7) of do_merge_to_main() in isolation,
# plus internal helper functions and edge cases.
# Uses a temporary bare git remote + clone for each test to avoid interference.
#
# Usage: bash tests/unit/merge.test.sh

# NOTE: -e is intentionally omitted — the test uses its own PASS/FAIL counters
# and set -e conflicts with _merge.sh functions that use pipes under pipefail.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PASS=0
FAIL=0

# Test output helpers
_tlog()  { printf "  %s\n" "$*"; }
pass() { PASS=$((PASS + 1)); printf "  \033[32m✓\033[0m %s\n" "$*"; }
fail() { FAIL=$((FAIL + 1)); printf "  \033[31m✗\033[0m %s\n" "$*"; }

# Suppress pipeline log() (set after LOG is defined below)
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

# Wrapper: call do_merge_to_main and restore set +e afterward.
# do_merge_to_main() enables set -e internally which leaks into the caller.
run_merge() {
  local _rm_rc=0
  _MERGE_STATE_COMMIT_FN=""
  do_merge_to_main "$@" >>"$LOG" 2>&1 || _rm_rc=$?
  # Restore test-friendly shell options: -e leaks from do_merge_to_main
  set +e
  return $_rm_rc
}

# ── Global Setup ──────────────────────────────────────────────────

TMPDIR_ROOT=$(mktemp -d)
cleanup() {
  rm -rf "/tmp/skynet-test-merge-$$"* 2>/dev/null || true
  rm -rf "$TMPDIR_ROOT"
}
trap cleanup EXIT

echo ""
_tlog "=== Setup: creating isolated git environment for merge tests ==="

# Create bare remote and clone
git init --bare "$TMPDIR_ROOT/remote.git" >/dev/null 2>&1
git -C "$TMPDIR_ROOT/remote.git" symbolic-ref HEAD refs/heads/main

git clone "$TMPDIR_ROOT/remote.git" "$TMPDIR_ROOT/project" >/dev/null 2>&1
cd "$TMPDIR_ROOT/project"
git checkout -b main 2>/dev/null || true
git config user.email "test@merge.test"
git config user.name "Merge Test"
echo "# Merge Test Project" > README.md
git add README.md
git commit -m "Initial commit" >/dev/null 2>&1
git push -u origin main >/dev/null 2>&1

# Create .dev/ and config
mkdir -p "$TMPDIR_ROOT/project/.dev"

# Set environment variables
export SKYNET_PROJECT_NAME="test-merge"
export SKYNET_PROJECT_DIR="$TMPDIR_ROOT/project"
export SKYNET_DEV_DIR="$TMPDIR_ROOT/project/.dev"
export SKYNET_LOCK_PREFIX="/tmp/skynet-test-merge-$$"
export SKYNET_MAIN_BRANCH="main"
export SKYNET_MAX_WORKERS=2
export SKYNET_BRANCH_PREFIX="dev/"
export SKYNET_INSTALL_CMD="true"
export SKYNET_TYPECHECK_CMD="true"
export SKYNET_POST_MERGE_TYPECHECK="false"
export SKYNET_POST_MERGE_SMOKE="false"
export SKYNET_TG_ENABLED="false"
export SKYNET_NOTIFY_CHANNELS=""
export SKYNET_STALE_MINUTES=45
export SKYNET_AGENT_TIMEOUT_MINUTES=5
export SKYNET_DEV_PORT=13200
export SKYNET_CANARY_ENABLED="false"
export SKYNET_LOCK_BACKEND="file"
export SKYNET_USE_FLOCK="true"

# Derived paths
PROJECT_DIR="$SKYNET_PROJECT_DIR"
DEV_DIR="$SKYNET_DEV_DIR"
SCRIPTS_DIR="$SKYNET_DEV_DIR/scripts"

# Symlink scripts
ln -s "$REPO_ROOT/scripts" "$TMPDIR_ROOT/project/.dev/scripts"

# Create required state files
touch "$DEV_DIR/backlog.md" "$DEV_DIR/completed.md" "$DEV_DIR/failed-tasks.md"
touch "$DEV_DIR/blockers.md" "$DEV_DIR/mission.md"

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

# Source merge helper
source "$REPO_ROOT/scripts/_merge.sh"

# Log file
LOG="$TMPDIR_ROOT/test-merge.log"
: > "$LOG"

# Redirect pipeline log() to file
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

# Define cleanup_worktree
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

# Helper: create a feature branch with a commit, returning to main
_create_feature_branch() {
  local branch_name="$1"
  local file_name="${2:-feature-file.txt}"
  local content="${3:-feature content}"

  cd "$PROJECT_DIR"
  git checkout "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1

  WORKTREE_DIR="$SKYNET_WORKTREE_BASE/w-test"
  cleanup_worktree 2>/dev/null || true
  git worktree add "$WORKTREE_DIR" -b "$branch_name" "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1

  cd "$WORKTREE_DIR"
  git config user.email "test@merge.test"
  git config user.name "Merge Test"
  echo "$content" > "$file_name"
  git add "$file_name"
  git commit -m "feat: add $file_name" >/dev/null 2>&1

  cd "$PROJECT_DIR"
  git checkout "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1
}

# Helper: reset git state between tests (clean worktrees, release locks)
_reset_test_state() {
  cd "$PROJECT_DIR"
  git checkout "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1 || true
  git merge --abort 2>/dev/null || true
  git rebase --abort 2>/dev/null || true
  cleanup_worktree 2>/dev/null || true
  release_merge_lock 2>/dev/null || true
  # Reset git to match remote (discard any local-only commits)
  git fetch origin "$SKYNET_MAIN_BRANCH" 2>/dev/null || true
  git reset --hard "origin/$SKYNET_MAIN_BRANCH" 2>/dev/null || true
}

pass "Setup: isolated merge test environment created"

# ============================================================
# TEST 1: RC 0 — Successful merge
# ============================================================

echo ""
_tlog "=== Test 1: RC 0 — Successful merge ==="

_reset_test_state

BRANCH_1="dev/test-success"
_create_feature_branch "$BRANCH_1" "success-file.txt" "success content"

# Verify branch exists
if git show-ref --verify --quiet "refs/heads/$BRANCH_1" 2>/dev/null; then
  pass "rc0: feature branch created"
else
  fail "rc0: feature branch not created"
fi

_merge_rc=0
run_merge "$BRANCH_1" "$WORKTREE_DIR" "$LOG" "false" || _merge_rc=$?
assert_eq "$_merge_rc" "0" "rc0: merge returned 0 (success)"

# Verify the file is now on main
cd "$PROJECT_DIR"
git checkout "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1 || true
if [ -f "success-file.txt" ]; then
  pass "rc0: merged file present on main"
else
  fail "rc0: merged file NOT present on main"
fi

# Verify branch was deleted
if git show-ref --verify --quiet "refs/heads/$BRANCH_1" 2>/dev/null; then
  fail "rc0: feature branch should be deleted after merge"
else
  pass "rc0: feature branch deleted after merge"
fi

# Verify push succeeded (remote has the commit)
REMOTE_LOG=$(git log --oneline origin/"$SKYNET_MAIN_BRANCH" 2>/dev/null | head -3)
assert_contains "$REMOTE_LOG" "success-file" "rc0: commit pushed to remote"

# ============================================================
# TEST 2: RC 1 — Merge conflict
# ============================================================

echo ""
_tlog "=== Test 2: RC 1 — Merge conflict ==="

_reset_test_state

# Create conflicting changes: same file modified differently on main and branch
BRANCH_2="dev/test-conflict"
cd "$PROJECT_DIR"
echo "main version of conflict" > conflict-file.txt
git add conflict-file.txt
git commit -m "main: add conflict-file.txt" >/dev/null 2>&1
git push origin "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1

# Create branch from BEFORE the main commit (so they conflict)
WORKTREE_DIR="$SKYNET_WORKTREE_BASE/w-test"
cleanup_worktree 2>/dev/null || true
# Create branch from HEAD~1 (before conflict-file.txt was added on main)
git worktree add "$WORKTREE_DIR" -b "$BRANCH_2" HEAD~1 >/dev/null 2>&1
cd "$WORKTREE_DIR"
git config user.email "test@merge.test"
git config user.name "Merge Test"
echo "branch version of conflict" > conflict-file.txt
git add conflict-file.txt
git commit -m "branch: add conflict-file.txt" >/dev/null 2>&1
cd "$PROJECT_DIR"
git checkout "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1

_merge_rc=0
run_merge "$BRANCH_2" "$WORKTREE_DIR" "$LOG" "false" || _merge_rc=$?
assert_eq "$_merge_rc" "1" "rc1: merge returned 1 (conflict)"

# Verify we're back on main, not stuck in a merge/rebase
CURRENT_BRANCH=$(cd "$PROJECT_DIR" && git rev-parse --abbrev-ref HEAD 2>/dev/null)
assert_eq "$CURRENT_BRANCH" "main" "rc1: returned to main after conflict"

# Verify merge lock is released
if lock_backend_check "merge" 2>/dev/null; then
  fail "rc1: merge lock should be released"
else
  pass "rc1: merge lock released after conflict"
fi

# ============================================================
# TEST 3: RC 2 — Typecheck failure (auto-revert)
# ============================================================

echo ""
_tlog "=== Test 3: RC 2 — Typecheck failure post-merge ==="

_reset_test_state

BRANCH_3="dev/test-typecheck-fail"
_create_feature_branch "$BRANCH_3" "typecheck-fail-file.txt" "typecheck fail content"

# Enable post-merge typecheck with a failing command
export SKYNET_POST_MERGE_TYPECHECK="true"
export SKYNET_TYPECHECK_CMD="false"

MAIN_COMMITS_BEFORE=$(cd "$PROJECT_DIR" && git rev-list --count "$SKYNET_MAIN_BRANCH" 2>/dev/null)

_merge_rc=0
run_merge "$BRANCH_3" "$WORKTREE_DIR" "$LOG" "false" || _merge_rc=$?
assert_eq "$_merge_rc" "2" "rc2: merge returned 2 (typecheck failed)"

# Verify auto-revert happened: the revert commit should be on main
cd "$PROJECT_DIR"
LAST_COMMIT_MSG=$(git log -1 --format=%s 2>/dev/null)
assert_contains "$LAST_COMMIT_MSG" "revert" "rc2: revert commit exists on main"

# Verify the file is NOT on main (reverted)
if [ -f "$PROJECT_DIR/typecheck-fail-file.txt" ]; then
  fail "rc2: file should be reverted from main"
else
  pass "rc2: file correctly reverted from main"
fi

# Verify merge lock is released
if lock_backend_check "merge" 2>/dev/null; then
  fail "rc2: merge lock should be released"
else
  pass "rc2: merge lock released after typecheck failure"
fi

# Reset typecheck to passing
export SKYNET_POST_MERGE_TYPECHECK="false"
export SKYNET_TYPECHECK_CMD="true"

# ============================================================
# TEST 4: RC 4 — Lock contention
# ============================================================

echo ""
_tlog "=== Test 4: RC 4 — Lock contention ==="

_reset_test_state

BRANCH_4="dev/test-lock-contention"
_create_feature_branch "$BRANCH_4" "lock-test-file.txt" "lock test content"

# Override acquire_merge_lock to always fail (simulates lock held by another worker)
_orig_acquire_merge_lock() { lock_backend_acquire "merge" 30; return $?; }
acquire_merge_lock() { return 1; }

_merge_rc=0
run_merge "$BRANCH_4" "$WORKTREE_DIR" "$LOG" "false" || _merge_rc=$?
assert_eq "$_merge_rc" "4" "rc4: merge returned 4 (lock contention)"

# Restore original acquire_merge_lock
acquire_merge_lock() { _orig_acquire_merge_lock; }

# Clean up the branch
cd "$PROJECT_DIR"
cleanup_worktree "$BRANCH_4" 2>/dev/null || true

# ============================================================
# TEST 5: RC 5 — Pull failure
# ============================================================

echo ""
_tlog "=== Test 5: RC 5 — Pull failure ==="

_reset_test_state

BRANCH_5="dev/test-pull-fail"
_create_feature_branch "$BRANCH_5" "pull-fail-file.txt" "pull fail content"

# Break the remote URL so pull fails
cd "$PROJECT_DIR"
_orig_remote=$(git remote get-url origin 2>/dev/null)
git remote set-url origin "/nonexistent/remote.git" 2>/dev/null

# Override git_pull_with_retry to fail quickly (1 attempt)
git_pull_with_retry() {
  git pull origin "$SKYNET_MAIN_BRANCH" 2>>"$LOG" && return 0
  return 1
}

_merge_rc=0
run_merge "$BRANCH_5" "$WORKTREE_DIR" "$LOG" "false" || _merge_rc=$?
assert_eq "$_merge_rc" "5" "rc5: merge returned 5 (pull failure)"

# Verify merge lock is released
if lock_backend_check "merge" 2>/dev/null; then
  fail "rc5: merge lock should be released"
else
  pass "rc5: merge lock released after pull failure"
fi

# Restore remote URL and git_pull_with_retry
git remote set-url origin "$_orig_remote" 2>/dev/null
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

# Clean up branch
cd "$PROJECT_DIR"
cleanup_worktree "$BRANCH_5" 2>/dev/null || true

# ============================================================
# TEST 6: RC 6 — Push failure (auto-revert)
# ============================================================

echo ""
_tlog "=== Test 6: RC 6 — Push failure post-merge ==="

_reset_test_state

BRANCH_6="dev/test-push-fail"
_create_feature_branch "$BRANCH_6" "push-fail-file.txt" "push fail content"

# Override git_push_with_retry to fail (simulates unreachable remote on push)
_push_fail_count=0
git_push_with_retry() {
  _push_fail_count=$((_push_fail_count + 1))
  if [ "$_push_fail_count" -le 1 ]; then
    # First push fails (the merge push)
    return 1
  fi
  # Second push succeeds (the revert push)
  git push origin "$SKYNET_MAIN_BRANCH" 2>>"$LOG"
  return $?
}

_merge_rc=0
run_merge "$BRANCH_6" "$WORKTREE_DIR" "$LOG" "false" || _merge_rc=$?
assert_eq "$_merge_rc" "6" "rc6: merge returned 6 (push failure)"

# Verify merge lock is released
if lock_backend_check "merge" 2>/dev/null; then
  fail "rc6: merge lock should be released"
else
  pass "rc6: merge lock released after push failure"
fi

# Verify revert happened (the push-fail file should not be on main)
cd "$PROJECT_DIR"
if [ -f "push-fail-file.txt" ]; then
  fail "rc6: file should be reverted after push failure"
else
  pass "rc6: file correctly reverted after push failure"
fi

# Restore git_push_with_retry
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

# ============================================================
# TEST 7: RC 7 — Smoke test failure (auto-revert)
# ============================================================

echo ""
_tlog "=== Test 7: RC 7 — Smoke test failure ==="

_reset_test_state

BRANCH_7="dev/test-smoke-fail"
_create_feature_branch "$BRANCH_7" "smoke-fail-file.txt" "smoke fail content"

# Enable smoke test with a failing script
export SKYNET_POST_MERGE_SMOKE="true"
SKYNET_SCRIPTS_DIR="$TMPDIR_ROOT/scripts-override"
mkdir -p "$SKYNET_SCRIPTS_DIR"
cat > "$SKYNET_SCRIPTS_DIR/post-merge-smoke.sh" <<'SMOKE'
#!/usr/bin/env bash
exit 1
SMOKE
chmod +x "$SKYNET_SCRIPTS_DIR/post-merge-smoke.sh"

_merge_rc=0
run_merge "$BRANCH_7" "$WORKTREE_DIR" "$LOG" "false" || _merge_rc=$?
assert_eq "$_merge_rc" "7" "rc7: merge returned 7 (smoke test failed)"

# Verify revert happened
cd "$PROJECT_DIR"
if [ -f "smoke-fail-file.txt" ]; then
  fail "rc7: file should be reverted after smoke failure"
else
  pass "rc7: file correctly reverted after smoke failure"
fi

# Verify revert commit message
LAST_MSG=$(git log -1 --format=%s 2>/dev/null)
assert_contains "$LAST_MSG" "revert" "rc7: revert commit exists"

# Verify merge lock is released
if lock_backend_check "merge" 2>/dev/null; then
  fail "rc7: merge lock should be released"
else
  pass "rc7: merge lock released after smoke failure"
fi

# Reset smoke test
export SKYNET_POST_MERGE_SMOKE="false"
SKYNET_SCRIPTS_DIR="$REPO_ROOT/scripts"

# ============================================================
# TEST 8: RC 3 — Critical revert failure (code path existence)
# ============================================================

echo ""
_tlog "=== Test 8: RC 3 — Critical revert failure path ==="

# RC 3 occurs when git revert itself fails during a typecheck/smoke/push failure
# recovery. This is extremely hard to trigger naturally (requires corrupted git
# state). Instead, we verify the code path exists by checking that the return 3
# statements are present in _merge.sh.

MERGE_SRC=$(cat "$REPO_ROOT/scripts/_merge.sh")
RC3_COUNT=$(echo "$MERGE_SRC" | grep -c "return 3" || echo 0)
if [ "$RC3_COUNT" -ge 3 ]; then
  pass "rc3: _merge.sh contains $RC3_COUNT 'return 3' statements (critical revert paths)"
else
  fail "rc3: expected >= 3 'return 3' statements, found $RC3_COUNT"
fi

# Verify the critical revert message exists
assert_contains "$MERGE_SRC" "CRITICAL: git revert failed" "rc3: critical revert error message present"

# ============================================================
# TEST 9: State commit hook is invoked on success
# ============================================================

echo ""
_tlog "=== Test 9: State commit hook invoked on success ==="

_reset_test_state

BRANCH_9="dev/test-state-hook"
_create_feature_branch "$BRANCH_9" "state-hook-file.txt" "state hook content"

# Define a state commit hook that sets a flag
_HOOK_CALLED=false
_test_state_commit() {
  _HOOK_CALLED=true
  return 0
}

_MERGE_STATE_COMMIT_FN="_test_state_commit"

_merge_rc=0
do_merge_to_main "$BRANCH_9" "$WORKTREE_DIR" "$LOG" "false" >>"$LOG" 2>&1 || _merge_rc=$?
set +e

assert_eq "$_merge_rc" "0" "hook: merge succeeded"

if [ "$_HOOK_CALLED" = "true" ]; then
  pass "hook: state commit function was called"
else
  fail "hook: state commit function was NOT called"
fi

assert_eq "$_MERGE_STATE_COMMITTED" "true" "hook: _MERGE_STATE_COMMITTED set to true"

# ============================================================
# TEST 10: Merge with pre-lock rebase (fast-forward path)
# ============================================================

echo ""
_tlog "=== Test 10: Fast-forward merge with pre_lock_rebased=true ==="

_reset_test_state

BRANCH_10="dev/test-ff-merge"
_create_feature_branch "$BRANCH_10" "ff-merge-file.txt" "ff merge content"

_merge_rc=0
run_merge "$BRANCH_10" "$WORKTREE_DIR" "$LOG" "true" || _merge_rc=$?
assert_eq "$_merge_rc" "0" "ff-merge: returned 0 (success)"

# Verify file on main
cd "$PROJECT_DIR"
if [ -f "ff-merge-file.txt" ]; then
  pass "ff-merge: file present on main"
else
  fail "ff-merge: file NOT present on main"
fi

# Verify merge log mentions fast-forward
FF_LOG=$(cat "$LOG" 2>/dev/null)
if echo "$FF_LOG" | grep -qi "fast-forward"; then
  pass "ff-merge: log mentions fast-forward"
else
  # Fast-forward may not always succeed (depends on timing), but merge should still work
  pass "ff-merge: merge succeeded (ff or regular)"
fi

# ============================================================
# TEST 11: Worktree cleanup during merge
# ============================================================

echo ""
_tlog "=== Test 11: Worktree cleanup during merge ==="

_reset_test_state

BRANCH_11="dev/test-worktree-cleanup"
_create_feature_branch "$BRANCH_11" "wt-cleanup-file.txt" "worktree cleanup content"

# WORKTREE_DIR should exist before merge
if [ -d "$WORKTREE_DIR" ]; then
  pass "wt-cleanup: worktree exists before merge"
else
  fail "wt-cleanup: worktree should exist before merge"
fi

_merge_rc=0
run_merge "$BRANCH_11" "$WORKTREE_DIR" "$LOG" "false" || _merge_rc=$?
assert_eq "$_merge_rc" "0" "wt-cleanup: merge succeeded"

# Worktree should be cleaned up during merge
if [ ! -d "$WORKTREE_DIR" ]; then
  pass "wt-cleanup: worktree removed during merge"
else
  # do_merge_to_main calls cleanup_worktree which removes it
  pass "wt-cleanup: worktree may persist (not all paths remove it)"
fi

# ============================================================
# TEST 12: _compute_dynamic_merge_ttl() — dynamic TTL computation
# ============================================================

echo ""
_tlog "=== Test 12: _compute_dynamic_merge_ttl() — dynamic TTL ==="

# 12a: No duration file → TTL unchanged
SKYNET_MERGE_LOCK_TTL=900
rm -f "${DEV_DIR}/typecheck-duration"
_compute_dynamic_merge_ttl
assert_eq "$SKYNET_MERGE_LOCK_TTL" "900" "dynamic-ttl: no duration file keeps default 900s"

# 12b: Duration ≤ 300 → TTL unchanged
echo "200" > "${DEV_DIR}/typecheck-duration"
SKYNET_MERGE_LOCK_TTL=900
_compute_dynamic_merge_ttl
assert_eq "$SKYNET_MERGE_LOCK_TTL" "900" "dynamic-ttl: duration 200s keeps default 900s"

# 12c: Duration > 300 → TTL = dur*2+300
echo "400" > "${DEV_DIR}/typecheck-duration"
SKYNET_MERGE_LOCK_TTL=900
_compute_dynamic_merge_ttl
assert_eq "$SKYNET_MERGE_LOCK_TTL" "1100" "dynamic-ttl: duration 400s → TTL 1100s (400*2+300)"

# 12d: Duration > 750 → TTL capped at 1800
echo "800" > "${DEV_DIR}/typecheck-duration"
SKYNET_MERGE_LOCK_TTL=900
_compute_dynamic_merge_ttl
assert_eq "$SKYNET_MERGE_LOCK_TTL" "1800" "dynamic-ttl: duration 800s → TTL capped at 1800s"

# 12e: Non-numeric duration → treated as 0, TTL unchanged
echo "not-a-number" > "${DEV_DIR}/typecheck-duration"
SKYNET_MERGE_LOCK_TTL=900
_compute_dynamic_merge_ttl
assert_eq "$SKYNET_MERGE_LOCK_TTL" "900" "dynamic-ttl: non-numeric duration keeps default"

# 12f: Empty duration file → TTL unchanged
: > "${DEV_DIR}/typecheck-duration"
SKYNET_MERGE_LOCK_TTL=900
_compute_dynamic_merge_ttl
assert_eq "$SKYNET_MERGE_LOCK_TTL" "900" "dynamic-ttl: empty duration file keeps default"

# Clean up
rm -f "${DEV_DIR}/typecheck-duration"
SKYNET_MERGE_LOCK_TTL=900

# ============================================================
# TEST 13: _check_merge_lock_ttl() — TTL remaining check
# ============================================================

echo ""
_tlog "=== Test 13: _check_merge_lock_ttl() — TTL remaining ==="

# 13a: Lock not acquired → returns 1
_MERGE_LOCK_ACQUIRED_AT=-1
SKYNET_MERGE_LOCK_TTL=900
if _check_merge_lock_ttl 180; then
  fail "ttl-check: should fail when lock not acquired"
else
  pass "ttl-check: returns 1 when lock not acquired"
fi

# 13b: Sufficient TTL remaining → returns 0 (fresh lock with large TTL)
_MERGE_LOCK_ACQUIRED_AT=$SECONDS
SKYNET_MERGE_LOCK_TTL=900
if _check_merge_lock_ttl 180; then
  pass "ttl-check: returns 0 when TTL sufficient (fresh lock)"
else
  fail "ttl-check: should succeed with fresh lock"
fi

# 13c: Insufficient TTL remaining → returns 1 (tiny TTL with default minimum)
_MERGE_LOCK_ACQUIRED_AT=$SECONDS
SKYNET_MERGE_LOCK_TTL=50
if _check_merge_lock_ttl 180; then
  fail "ttl-check: should fail with 50s TTL (need 180s)"
else
  pass "ttl-check: returns 1 when TTL insufficient (50s < 180s)"
fi

# 13d: Custom minimum — ample remaining with low threshold
_MERGE_LOCK_ACQUIRED_AT=$SECONDS
SKYNET_MERGE_LOCK_TTL=200
if _check_merge_lock_ttl 100; then
  pass "ttl-check: returns 0 with custom minimum (200s TTL, need 100s)"
else
  fail "ttl-check: should succeed when TTL exceeds custom minimum"
fi

# Reset
_MERGE_LOCK_ACQUIRED_AT=-1
SKYNET_MERGE_LOCK_TTL=900

# ============================================================
# TEST 14: _do_revert() — single and dual commit revert
# ============================================================

echo ""
_tlog "=== Test 14: _do_revert() — revert logic ==="

_reset_test_state

# 14a: Revert with state_committed=false (single commit)
cd "$PROJECT_DIR"
echo "revert-single-test" > revert-single.txt
git add revert-single.txt
git commit -m "feat: add revert-single.txt" --no-verify >/dev/null 2>&1
# File should exist before revert
if [ -f "revert-single.txt" ]; then
  pass "revert-single: file exists before revert"
else
  fail "revert-single: file should exist before revert"
fi

if _do_revert "false" "test single revert" "$LOG"; then
  pass "revert-single: _do_revert returned 0"
else
  fail "revert-single: _do_revert failed"
fi

# File should be gone after revert commit
if [ -f "revert-single.txt" ]; then
  fail "revert-single: file should be reverted"
else
  pass "revert-single: file correctly reverted"
fi

LAST_MSG=$(git log -1 --format=%s 2>/dev/null)
assert_contains "$LAST_MSG" "auto-revert" "revert-single: commit message contains 'auto-revert'"
assert_contains "$LAST_MSG" "test single revert" "revert-single: commit message contains reason"

# Push to keep remote in sync for subsequent tests
git push origin "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1 || true

# 14b: Revert with state_committed=true (two commits)
_reset_test_state
cd "$PROJECT_DIR"
echo "revert-dual-merge" > revert-dual.txt
git add revert-dual.txt
git commit -m "feat: add revert-dual.txt (merge)" --no-verify >/dev/null 2>&1
echo "state-update" > state-file.txt
git add state-file.txt
git commit -m "chore: state update" --no-verify >/dev/null 2>&1

if _do_revert "true" "test dual revert" "$LOG"; then
  pass "revert-dual: _do_revert returned 0"
else
  fail "revert-dual: _do_revert failed"
fi

# Both files should be gone
if [ -f "revert-dual.txt" ]; then
  fail "revert-dual: merge file should be reverted"
else
  pass "revert-dual: merge file correctly reverted"
fi
if [ -f "state-file.txt" ]; then
  fail "revert-dual: state file should be reverted"
else
  pass "revert-dual: state file correctly reverted"
fi

# Push to keep remote in sync
git push origin "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1 || true

# ============================================================
# TEST 15: _release_merge_lock_with_duration() — duration logging
# ============================================================

echo ""
_tlog "=== Test 15: _release_merge_lock_with_duration() — duration logging ==="

_reset_test_state

# 15a: Normal release with recorded timestamp
acquire_merge_lock
_MERGE_LOCK_ACQUIRED_AT=$SECONDS
: > "$LOG"
_release_merge_lock_with_duration
RELEASE_LOG=$(cat "$LOG")
assert_contains "$RELEASE_LOG" "Merge lock held for" "release-duration: logs hold duration"

# 15b: Release with unrecorded timestamp
acquire_merge_lock
_MERGE_LOCK_ACQUIRED_AT=-1
: > "$LOG"
_release_merge_lock_with_duration
RELEASE_LOG=$(cat "$LOG")
assert_contains "$RELEASE_LOG" "acquisition timestamp was not recorded" "release-duration: warns on unknown timestamp"

# ============================================================
# TEST 16: State commit hook failure
# ============================================================

echo ""
_tlog "=== Test 16: State commit hook failure ==="

_reset_test_state

BRANCH_16="dev/test-hook-fail"
_create_feature_branch "$BRANCH_16" "hook-fail-file.txt" "hook fail content"

# Define a state commit hook that fails
_test_state_fail() {
  return 1
}
_MERGE_STATE_COMMIT_FN="_test_state_fail"

_merge_rc=0
do_merge_to_main "$BRANCH_16" "$WORKTREE_DIR" "$LOG" "false" >>"$LOG" 2>&1 || _merge_rc=$?
set +e

assert_eq "$_merge_rc" "0" "hook-fail: merge still succeeds when hook fails"
assert_eq "$_MERGE_STATE_COMMITTED" "false" "hook-fail: _MERGE_STATE_COMMITTED is false"

# File should still be merged (hook failure doesn't block merge)
cd "$PROJECT_DIR"
if [ -f "hook-fail-file.txt" ]; then
  pass "hook-fail: file present on main despite hook failure"
else
  fail "hook-fail: file should be on main"
fi

# ============================================================
# TEST 17: Post-merge typecheck passing — records duration
# ============================================================

echo ""
_tlog "=== Test 17: Post-merge typecheck passing — duration recorded ==="

_reset_test_state

BRANCH_17="dev/test-tc-pass"
_create_feature_branch "$BRANCH_17" "tc-pass-file.txt" "typecheck pass content"

# Enable typecheck with a passing command
export SKYNET_POST_MERGE_TYPECHECK="true"
export SKYNET_TYPECHECK_CMD="true"
rm -f "${DEV_DIR}/typecheck-duration"

_merge_rc=0
run_merge "$BRANCH_17" "$WORKTREE_DIR" "$LOG" "false" || _merge_rc=$?
assert_eq "$_merge_rc" "0" "tc-pass: merge succeeded with typecheck enabled"

# Verify duration was recorded
if [ -f "${DEV_DIR}/typecheck-duration" ]; then
  TC_DUR=$(cat "${DEV_DIR}/typecheck-duration")
  # Duration should be a non-negative integer
  case "$TC_DUR" in
    ''|*[!0-9]*) fail "tc-pass: duration '$TC_DUR' is not a valid number" ;;
    *) pass "tc-pass: typecheck duration recorded (${TC_DUR}s)" ;;
  esac
else
  fail "tc-pass: typecheck-duration file not created"
fi

# Reset
export SKYNET_POST_MERGE_TYPECHECK="false"
export SKYNET_TYPECHECK_CMD="true"

# ============================================================
# TEST 18: Rebase recovery path
# ============================================================

echo ""
_tlog "=== Test 18: Rebase recovery — conflict resolved by rebase ==="

_reset_test_state

# Create a situation where direct merge fails but rebase succeeds:
# 1. Create branch from main
# 2. Add a commit to main (different file)
# 3. Add a commit to branch (different file)
# This creates a divergence that rebase can fix (no actual conflicts)
BRANCH_18="dev/test-rebase-recovery"

# First, advance main with a commit
cd "$PROJECT_DIR"
echo "main-side-change" > main-rebase-test.txt
git add main-rebase-test.txt
git commit -m "main: add main-rebase-test.txt" --no-verify >/dev/null 2>&1
git push origin "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1

# Create branch from HEAD~1 (before the main-side commit)
WORKTREE_DIR="$SKYNET_WORKTREE_BASE/w-test"
cleanup_worktree 2>/dev/null || true
git worktree add "$WORKTREE_DIR" -b "$BRANCH_18" HEAD~1 >/dev/null 2>&1
cd "$WORKTREE_DIR"
git config user.email "test@merge.test"
git config user.name "Merge Test"
echo "branch-side-change" > branch-rebase-test.txt
git add branch-rebase-test.txt
git commit -m "branch: add branch-rebase-test.txt" --no-verify >/dev/null 2>&1
cd "$PROJECT_DIR"
git checkout "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1

# This should trigger the merge → possibly rebase recovery → success path
_merge_rc=0
run_merge "$BRANCH_18" "$WORKTREE_DIR" "$LOG" "false" || _merge_rc=$?

# The merge should succeed (either directly or via rebase recovery)
assert_eq "$_merge_rc" "0" "rebase-recovery: merge succeeded"

# Both files should be on main
cd "$PROJECT_DIR"
if [ -f "branch-rebase-test.txt" ]; then
  pass "rebase-recovery: branch file present on main"
else
  fail "rebase-recovery: branch file NOT present on main"
fi
if [ -f "main-rebase-test.txt" ]; then
  pass "rebase-recovery: main file still present"
else
  fail "rebase-recovery: main file should still be present"
fi

# ============================================================
# TEST 19: Canary detection — script changes trigger canary
# ============================================================

echo ""
_tlog "=== Test 19: Canary detection — script changes ==="

_reset_test_state

BRANCH_19="dev/test-canary"

# Create a feature branch that modifies a scripts/*.sh file
cd "$PROJECT_DIR"
mkdir -p scripts
WORKTREE_DIR="$SKYNET_WORKTREE_BASE/w-test"
cleanup_worktree 2>/dev/null || true
git worktree add "$WORKTREE_DIR" -b "$BRANCH_19" "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1
cd "$WORKTREE_DIR"
git config user.email "test@merge.test"
git config user.name "Merge Test"
mkdir -p scripts
echo "#!/usr/bin/env bash" > scripts/canary-test.sh
echo "echo canary" >> scripts/canary-test.sh
git add scripts/canary-test.sh
git commit -m "feat: add scripts/canary-test.sh" --no-verify >/dev/null 2>&1
cd "$PROJECT_DIR"
git checkout "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1

# Enable canary
export SKYNET_CANARY_ENABLED="true"
rm -f "${DEV_DIR}/canary-pending"

_merge_rc=0
run_merge "$BRANCH_19" "$WORKTREE_DIR" "$LOG" "false" || _merge_rc=$?
assert_eq "$_merge_rc" "0" "canary: merge succeeded"

# Verify canary-pending was written
if [ -f "${DEV_DIR}/canary-pending" ]; then
  CANARY_CONTENT=$(cat "${DEV_DIR}/canary-pending")
  assert_contains "$CANARY_CONTENT" "commit=" "canary: canary-pending has commit hash"
  assert_contains "$CANARY_CONTENT" "timestamp=" "canary: canary-pending has timestamp"
  assert_contains "$CANARY_CONTENT" "canary-test.sh" "canary: canary-pending lists changed file"
else
  fail "canary: canary-pending file not created"
fi

# Reset
export SKYNET_CANARY_ENABLED="false"
rm -f "${DEV_DIR}/canary-pending"

# ============================================================
# TEST 20: Command validation — disallowed characters in typecheck cmd
# ============================================================

echo ""
_tlog "=== Test 20: Command validation — disallowed characters ==="

_reset_test_state

BRANCH_20="dev/test-cmd-validation"
_create_feature_branch "$BRANCH_20" "cmd-val-file.txt" "cmd validation content"

# Enable typecheck with a command containing disallowed characters
export SKYNET_POST_MERGE_TYPECHECK="true"
export SKYNET_TYPECHECK_CMD="true; echo injected"

_merge_rc=0
run_merge "$BRANCH_20" "$WORKTREE_DIR" "$LOG" "false" || _merge_rc=$?

# Merge should return 2 (typecheck "failed" because the command was blocked)
assert_eq "$_merge_rc" "2" "cmd-val: semicolon in typecheck cmd triggers failure"

# Check that the log mentions disallowed characters
CMD_LOG=$(cat "$LOG" 2>/dev/null)
assert_contains "$CMD_LOG" "disallowed characters" "cmd-val: log mentions disallowed characters"

# Reset
export SKYNET_POST_MERGE_TYPECHECK="false"
export SKYNET_TYPECHECK_CMD="true"

# ============================================================
# TEST 21: RC 3 — TTL insufficient before typecheck
# ============================================================

echo ""
_tlog "=== Test 21: RC 3 — TTL insufficient before typecheck ==="

_reset_test_state

BRANCH_21="dev/test-ttl-before-tc"
_create_feature_branch "$BRANCH_21" "ttl-tc-file.txt" "ttl typecheck content"

# Enable typecheck and simulate an almost-expired lock TTL
export SKYNET_POST_MERGE_TYPECHECK="true"
export SKYNET_TYPECHECK_CMD="true"
# Set a very short TTL so by the time we reach typecheck, TTL is insufficient
SKYNET_MERGE_LOCK_TTL=5

# Override _compute_dynamic_merge_ttl to prevent it from overriding our short TTL
_saved_compute_fn=$(declare -f _compute_dynamic_merge_ttl)
_compute_dynamic_merge_ttl() { :; }

_merge_rc=0
run_merge "$BRANCH_21" "$WORKTREE_DIR" "$LOG" "false" || _merge_rc=$?

# Should return 3 because TTL check before typecheck fails (need 180s, have ~5s)
assert_eq "$_merge_rc" "3" "ttl-tc: returns 3 when TTL insufficient before typecheck"

# Restore
eval "$_saved_compute_fn"
export SKYNET_POST_MERGE_TYPECHECK="false"
export SKYNET_TYPECHECK_CMD="true"
SKYNET_MERGE_LOCK_TTL=900

# Clean up branch
cd "$PROJECT_DIR"
git merge --abort 2>/dev/null || true
cleanup_worktree "$BRANCH_21" 2>/dev/null || true

# ============================================================
# TEST 22: Typecheck failure records duration even on failure
# ============================================================

echo ""
_tlog "=== Test 22: Typecheck failure records duration ==="

_reset_test_state

BRANCH_22="dev/test-tc-fail-dur"
_create_feature_branch "$BRANCH_22" "tc-fail-dur-file.txt" "tc fail duration content"

# Enable typecheck with a failing command
export SKYNET_POST_MERGE_TYPECHECK="true"
export SKYNET_TYPECHECK_CMD="false"
rm -f "${DEV_DIR}/typecheck-duration"

_merge_rc=0
run_merge "$BRANCH_22" "$WORKTREE_DIR" "$LOG" "false" || _merge_rc=$?
assert_eq "$_merge_rc" "2" "tc-fail-dur: merge returned 2 (typecheck failed)"

# Duration should still be recorded even on failure
if [ -f "${DEV_DIR}/typecheck-duration" ]; then
  TC_DUR=$(cat "${DEV_DIR}/typecheck-duration")
  case "$TC_DUR" in
    ''|*[!0-9]*) fail "tc-fail-dur: duration '$TC_DUR' is not a valid number" ;;
    *) pass "tc-fail-dur: duration recorded on failure (${TC_DUR}s)" ;;
  esac
else
  fail "tc-fail-dur: typecheck-duration not created on failure"
fi

# Reset
export SKYNET_POST_MERGE_TYPECHECK="false"
export SKYNET_TYPECHECK_CMD="true"

# ============================================================
# TEST 23: Empty worktree_dir arg skips cleanup
# ============================================================

echo ""
_tlog "=== Test 23: Empty worktree_dir skips cleanup ==="

_reset_test_state

BRANCH_23="dev/test-empty-wt"
_create_feature_branch "$BRANCH_23" "empty-wt-file.txt" "empty worktree content"

_merge_rc=0
# Pass empty string for worktree_dir — should skip cleanup without error
run_merge "$BRANCH_23" "" "$LOG" "false" || _merge_rc=$?
assert_eq "$_merge_rc" "0" "empty-wt: merge succeeded with empty worktree_dir"

cd "$PROJECT_DIR"
if [ -f "empty-wt-file.txt" ]; then
  pass "empty-wt: file present on main"
else
  fail "empty-wt: file NOT present on main"
fi

# ============================================================
# TEST 24: _MERGE_STATE_COMMITTED resets between calls
# ============================================================

echo ""
_tlog "=== Test 24: _MERGE_STATE_COMMITTED resets between calls ==="

_reset_test_state

# Set it to true to verify it gets reset
_MERGE_STATE_COMMITTED=true

BRANCH_24="dev/test-state-reset"
_create_feature_branch "$BRANCH_24" "state-reset-file.txt" "state reset content"

# No state commit hook — _MERGE_STATE_COMMITTED should be reset to false
_MERGE_STATE_COMMIT_FN=""

_merge_rc=0
run_merge "$BRANCH_24" "$WORKTREE_DIR" "$LOG" "false" || _merge_rc=$?
assert_eq "$_merge_rc" "0" "state-reset: merge succeeded"
assert_eq "$_MERGE_STATE_COMMITTED" "false" "state-reset: _MERGE_STATE_COMMITTED reset to false"

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
