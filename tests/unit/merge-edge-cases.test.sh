#!/usr/bin/env bash
# tests/unit/merge-edge-cases.test.sh — Edge-case unit tests for _merge.sh
#
# Complements merge.test.sh and merge-helpers.test.sh with additional
# edge-case coverage for code paths not exercised by the existing tests.
#
# Coverage gaps addressed:
#   - _merge_push_with_ttl_guard: retry logging, max_attempts=1, no staged diff
#   - _release_merge_lock_with_duration: resets _MERGE_LOCK_ACQUIRED_AT
#   - _compute_dynamic_merge_ttl: exact cap boundary, very large duration
#   - Typecheck disabled skips duration recording
#   - Install skipped when node_modules/.modules.yaml missing
#   - Sequential merges reset state correctly
#   - Rebase recovery: rebase succeeds but post-rebase merge fails
#   - _check_merge_lock_ttl: min_remaining=0 edge case
#   - Branch deletion after merge (-d/-D fallback)
#
# Usage: bash tests/unit/merge-edge-cases.test.sh

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

assert_not_contains() {
  local haystack="$1" needle="$2" msg="$3"
  if echo "$haystack" | grep -qF "$needle"; then
    fail "$msg (should NOT contain '$needle')"
  else
    pass "$msg"
  fi
}

assert_not_empty() {
  local val="$1" msg="$2"
  if [ -n "$val" ]; then pass "$msg"
  else fail "$msg (was empty)"; fi
}

# Wrapper: call do_merge_to_main and restore set +e afterward.
run_merge() {
  local _rm_rc=0
  _MERGE_STATE_COMMIT_FN=""
  do_merge_to_main "$@" >>"$LOG" 2>&1 || _rm_rc=$?
  set +e
  return $_rm_rc
}

# ── Global Setup ──────────────────────────────────────────────────

TMPDIR_ROOT=$(mktemp -d)
cleanup() {
  rm -rf "/tmp/skynet-test-merge-edge-$$"* 2>/dev/null || true
  rm -rf "$TMPDIR_ROOT"
}
trap cleanup EXIT

echo ""
_tlog "=== Setup: creating isolated git environment for merge edge-case tests ==="

# Create bare remote and clone
git init --bare "$TMPDIR_ROOT/remote.git" >/dev/null 2>&1
git -C "$TMPDIR_ROOT/remote.git" symbolic-ref HEAD refs/heads/main

git clone "$TMPDIR_ROOT/remote.git" "$TMPDIR_ROOT/project" >/dev/null 2>&1
cd "$TMPDIR_ROOT/project"
git checkout -b main 2>/dev/null || true
git config user.email "test@merge-edge.test"
git config user.name "Merge Edge Test"
echo "# Merge Edge-Case Test Project" > README.md
git add README.md
git commit -m "Initial commit" >/dev/null 2>&1
git push -u origin main >/dev/null 2>&1

# Create .dev/ and config
mkdir -p "$TMPDIR_ROOT/project/.dev"

# Set environment variables
export SKYNET_PROJECT_NAME="test-merge-edge"
export SKYNET_PROJECT_DIR="$TMPDIR_ROOT/project"
export SKYNET_DEV_DIR="$TMPDIR_ROOT/project/.dev"
export SKYNET_LOCK_PREFIX="/tmp/skynet-test-merge-edge-$$"
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
export SKYNET_DEV_PORT=13202
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
LOG="$TMPDIR_ROOT/test-merge-edge.log"
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
  git config user.email "test@merge-edge.test"
  git config user.name "Merge Edge Test"
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
  git fetch origin "$SKYNET_MAIN_BRANCH" 2>/dev/null || true
  git reset --hard "origin/$SKYNET_MAIN_BRANCH" 2>/dev/null || true
}

pass "Setup: isolated merge edge-case test environment created"

# ============================================================
# TEST 1: _merge_push_with_ttl_guard — retry log message
# ============================================================
# When a push attempt fails and retries, the log should contain
# "git push attempt N/M (TTL-guarded)..." for attempts > 1.

echo ""
_tlog "=== Test 1: _merge_push_with_ttl_guard — retry log message ==="

_MERGE_LOCK_ACQUIRED_AT=$SECONDS
SKYNET_MERGE_LOCK_TTL=9999
SKYNET_GIT_PUSH_TIMEOUT=120

_push_attempt_e1=0
_saved_rwt_e1=$(declare -f run_with_timeout 2>/dev/null || true)
run_with_timeout() {
  _push_attempt_e1=$((_push_attempt_e1 + 1))
  # Fail first two attempts, succeed on third
  if [ "$_push_attempt_e1" -lt 3 ]; then return 1; fi
  return 0
}

: > "$LOG"
_ptg_rc=0
_merge_push_with_ttl_guard 3 || _ptg_rc=$?
assert_eq "$_ptg_rc" "0" "push-retry-log: returns 0 after third attempt succeeds"

RETRY_LOG=$(cat "$LOG" 2>/dev/null)
assert_contains "$RETRY_LOG" "git push attempt 2/3" "push-retry-log: attempt 2/3 logged"
assert_contains "$RETRY_LOG" "git push attempt 3/3" "push-retry-log: attempt 3/3 logged"
assert_not_contains "$RETRY_LOG" "git push attempt 1/3" "push-retry-log: attempt 1 not logged (only retries)"

# Restore
if [ -n "$_saved_rwt_e1" ]; then
  eval "$_saved_rwt_e1"
else
  run_with_timeout() { shift; "$@"; }
fi
_MERGE_LOCK_ACQUIRED_AT=-1
SKYNET_MERGE_LOCK_TTL=900

# ============================================================
# TEST 2: _merge_push_with_ttl_guard — max_attempts=1
# ============================================================
# With max_attempts=1, only one push attempt is made — no retries.

echo ""
_tlog "=== Test 2: _merge_push_with_ttl_guard — single attempt (max_attempts=1) ==="

_MERGE_LOCK_ACQUIRED_AT=$SECONDS
SKYNET_MERGE_LOCK_TTL=9999
SKYNET_GIT_PUSH_TIMEOUT=120

_push_count_e2=0
_saved_rwt_e2=$(declare -f run_with_timeout 2>/dev/null || true)
run_with_timeout() {
  _push_count_e2=$((_push_count_e2 + 1))
  return 1  # Always fail
}

: > "$LOG"
_ptg_rc=0
_merge_push_with_ttl_guard 1 || _ptg_rc=$?
assert_eq "$_ptg_rc" "1" "push-single: returns 1 when single attempt fails"
assert_eq "$_push_count_e2" "1" "push-single: exactly one push attempt made"

SINGLE_LOG=$(cat "$LOG" 2>/dev/null)
assert_contains "$SINGLE_LOG" "git push failed after 1 attempts" "push-single: log mentions 1 attempt exhausted"

# Restore
if [ -n "$_saved_rwt_e2" ]; then
  eval "$_saved_rwt_e2"
else
  run_with_timeout() { shift; "$@"; }
fi
_MERGE_LOCK_ACQUIRED_AT=-1
SKYNET_MERGE_LOCK_TTL=900

# ============================================================
# TEST 3: _merge_push_with_ttl_guard — no staged diff (default timeout)
# ============================================================
# When there are no staged changes (diff_lines=0), the push timeout
# should stay at the default SKYNET_GIT_PUSH_TIMEOUT, not doubled.

echo ""
_tlog "=== Test 3: _merge_push_with_ttl_guard — default timeout for small diff ==="

_MERGE_LOCK_ACQUIRED_AT=$SECONDS
SKYNET_MERGE_LOCK_TTL=9999
SKYNET_GIT_PUSH_TIMEOUT=120

_push_timeout_e3=""
_saved_rwt_e3=$(declare -f run_with_timeout 2>/dev/null || true)
run_with_timeout() {
  _push_timeout_e3="$1"
  return 0
}

# Ensure no staged changes
cd "$PROJECT_DIR"
git reset HEAD 2>/dev/null || true

: > "$LOG"
_merge_push_with_ttl_guard 1

assert_eq "$_push_timeout_e3" "120" "push-default-timeout: push timeout stays at 120s with no staged diff"

NODIFF_LOG=$(cat "$LOG" 2>/dev/null)
assert_not_contains "$NODIFF_LOG" "Large diff detected" "push-default-timeout: no large diff message"

# Restore
if [ -n "$_saved_rwt_e3" ]; then
  eval "$_saved_rwt_e3"
else
  run_with_timeout() { shift; "$@"; }
fi
_MERGE_LOCK_ACQUIRED_AT=-1
SKYNET_MERGE_LOCK_TTL=900

# ============================================================
# TEST 4: _release_merge_lock_with_duration — resets _MERGE_LOCK_ACQUIRED_AT
# ============================================================
# After releasing the merge lock, _MERGE_LOCK_ACQUIRED_AT should
# be reset to -1 to prevent stale timestamp from leaking to next merge.

echo ""
_tlog "=== Test 4: _release_merge_lock_with_duration — resets acquisition timestamp ==="

_reset_test_state

acquire_merge_lock
_MERGE_LOCK_ACQUIRED_AT=$SECONDS
: > "$LOG"
_release_merge_lock_with_duration

assert_eq "$_MERGE_LOCK_ACQUIRED_AT" "-1" "release-reset: _MERGE_LOCK_ACQUIRED_AT reset to -1 after release"

# ============================================================
# TEST 5: _compute_dynamic_merge_ttl — exact cap boundary (750)
# ============================================================
# When duration=750, computed = 750*2+300 = 1800, which equals the cap.
# The cap check is `> 1800`, so 1800 should NOT be capped (stays at 1800).

echo ""
_tlog "=== Test 5: _compute_dynamic_merge_ttl — exact cap boundary (750 → 1800) ==="

echo "750" > "${DEV_DIR}/typecheck-duration"
SKYNET_MERGE_LOCK_TTL=900
_compute_dynamic_merge_ttl
assert_eq "$SKYNET_MERGE_LOCK_TTL" "1800" "ttl-cap-boundary: duration=750 → computed 1800 stays at 1800 (not capped)"

# Clean up
rm -f "${DEV_DIR}/typecheck-duration"
SKYNET_MERGE_LOCK_TTL=900

# ============================================================
# TEST 6: _compute_dynamic_merge_ttl — very large duration
# ============================================================
# When duration=2000, computed = 2000*2+300 = 4300, capped to 1800.

echo ""
_tlog "=== Test 6: _compute_dynamic_merge_ttl — very large duration capped ==="

echo "2000" > "${DEV_DIR}/typecheck-duration"
SKYNET_MERGE_LOCK_TTL=900
_compute_dynamic_merge_ttl
assert_eq "$SKYNET_MERGE_LOCK_TTL" "1800" "ttl-large-dur: duration=2000 → computed 4300 capped to 1800"

# Clean up
rm -f "${DEV_DIR}/typecheck-duration"
SKYNET_MERGE_LOCK_TTL=900

# ============================================================
# TEST 7: Typecheck disabled — no duration file written
# ============================================================
# When SKYNET_POST_MERGE_TYPECHECK=false, the typecheck-duration
# file should not be created or modified.

echo ""
_tlog "=== Test 7: Typecheck disabled — no duration file written ==="

_reset_test_state

BRANCH_E7="dev/test-tc-disabled-dur"
_create_feature_branch "$BRANCH_E7" "tc-disabled-dur.txt" "tc disabled content"

export SKYNET_POST_MERGE_TYPECHECK="false"
rm -f "${DEV_DIR}/typecheck-duration"

_merge_rc=0
run_merge "$BRANCH_E7" "$WORKTREE_DIR" "$LOG" "false" || _merge_rc=$?
assert_eq "$_merge_rc" "0" "tc-disabled-dur: merge succeeded"

if [ ! -f "${DEV_DIR}/typecheck-duration" ]; then
  pass "tc-disabled-dur: typecheck-duration file NOT created when typecheck disabled"
else
  fail "tc-disabled-dur: typecheck-duration should not exist when typecheck disabled"
fi

# ============================================================
# TEST 8: Install skipped when node_modules/.modules.yaml missing
# ============================================================
# The install check at line 342 requires BOTH pnpm-lock.yaml AND
# node_modules/.modules.yaml. When .modules.yaml is missing, install
# should be skipped.

echo ""
_tlog "=== Test 8: Install skipped when .modules.yaml missing ==="

_reset_test_state

BRANCH_E8="dev/test-no-modules-yaml"
_create_feature_branch "$BRANCH_E8" "no-modules-yaml.txt" "no modules yaml content"

export SKYNET_POST_MERGE_TYPECHECK="true"
export SKYNET_TYPECHECK_CMD="true"

cd "$PROJECT_DIR"
# Create pnpm-lock.yaml but NOT node_modules/.modules.yaml
echo "lockfile" > pnpm-lock.yaml
git add pnpm-lock.yaml
git commit -m "add lock file" --no-verify >/dev/null 2>&1
git push origin "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1
rm -rf node_modules

: > "$LOG"
_merge_rc=0
run_merge "$BRANCH_E8" "$WORKTREE_DIR" "$LOG" "false" || _merge_rc=$?
assert_eq "$_merge_rc" "0" "no-modules-yaml: merge succeeded"

NM_LOG=$(cat "$LOG" 2>/dev/null)
assert_not_contains "$NM_LOG" "Lock file newer than node_modules" "no-modules-yaml: install skipped when .modules.yaml missing"

# Reset
export SKYNET_POST_MERGE_TYPECHECK="false"
export SKYNET_TYPECHECK_CMD="true"

# ============================================================
# TEST 9: Sequential merges reset state correctly
# ============================================================
# Two merges in a row — the second should work correctly with
# clean state (_MERGE_STATE_COMMITTED reset, lock released, etc.).

echo ""
_tlog "=== Test 9: Sequential merges — state resets correctly ==="

_reset_test_state

# First merge
BRANCH_E9a="dev/test-seq-merge-a"
_create_feature_branch "$BRANCH_E9a" "seq-merge-a.txt" "sequential merge A"

_merge_rc=0
run_merge "$BRANCH_E9a" "$WORKTREE_DIR" "$LOG" "false" || _merge_rc=$?
assert_eq "$_merge_rc" "0" "seq-merge-a: first merge succeeded"

# Second merge (without explicit reset — tests internal cleanup)
BRANCH_E9b="dev/test-seq-merge-b"
_create_feature_branch "$BRANCH_E9b" "seq-merge-b.txt" "sequential merge B"

_merge_rc=0
run_merge "$BRANCH_E9b" "$WORKTREE_DIR" "$LOG" "false" || _merge_rc=$?
assert_eq "$_merge_rc" "0" "seq-merge-b: second merge succeeded"

# Verify both files on main
cd "$PROJECT_DIR"
if [ -f "seq-merge-a.txt" ] && [ -f "seq-merge-b.txt" ]; then
  pass "seq-merge: both files present on main"
else
  fail "seq-merge: both files should be on main"
fi

assert_eq "$_MERGE_STATE_COMMITTED" "false" "seq-merge: _MERGE_STATE_COMMITTED reset after second merge"

# ============================================================
# TEST 10: _check_merge_lock_ttl — min_remaining=0
# ============================================================
# With min_remaining=0, the check should pass as long as remaining >= 0.

echo ""
_tlog "=== Test 10: _check_merge_lock_ttl — min_remaining=0 ==="

# remaining > 0, need 0 → should pass
_MERGE_LOCK_ACQUIRED_AT=$SECONDS
SKYNET_MERGE_LOCK_TTL=$(( SECONDS + 10 ))

_ttl_rc=0
_check_merge_lock_ttl 0 || _ttl_rc=$?
assert_eq "$_ttl_rc" "0" "ttl-min-zero: remaining=10, need 0 → returns 0"

# remaining = 0, need 0 → 0 < 0 is false → should pass
_MERGE_LOCK_ACQUIRED_AT=0
SKYNET_MERGE_LOCK_TTL=$SECONDS  # remaining = SECONDS - SECONDS = 0

_ttl_rc=0
_check_merge_lock_ttl 0 || _ttl_rc=$?
assert_eq "$_ttl_rc" "0" "ttl-min-zero-exact: remaining=0, need 0 → returns 0"

# Reset
_MERGE_LOCK_ACQUIRED_AT=-1
SKYNET_MERGE_LOCK_TTL=900

# ============================================================
# TEST 11: Branch deletion after successful merge
# ============================================================
# After a successful merge, the feature branch should be deleted.
# Tests both the `git branch -d` and `|| git branch -D` paths
# at line 396.

echo ""
_tlog "=== Test 11: Branch deletion after successful merge ==="

_reset_test_state

BRANCH_E11="dev/test-branch-delete"
_create_feature_branch "$BRANCH_E11" "branch-delete.txt" "branch delete content"

# Verify branch exists before merge
if git show-ref --verify --quiet "refs/heads/$BRANCH_E11" 2>/dev/null; then
  pass "branch-delete: feature branch exists before merge"
else
  fail "branch-delete: feature branch should exist before merge"
fi

_merge_rc=0
run_merge "$BRANCH_E11" "$WORKTREE_DIR" "$LOG" "false" || _merge_rc=$?
assert_eq "$_merge_rc" "0" "branch-delete: merge succeeded"

# Verify branch was deleted
cd "$PROJECT_DIR"
if git show-ref --verify --quiet "refs/heads/$BRANCH_E11" 2>/dev/null; then
  fail "branch-delete: feature branch should be deleted after merge"
else
  pass "branch-delete: feature branch deleted after successful merge"
fi

# ============================================================
# TEST 12: _MERGE_LOCK_ACQUIRED_AT recorded during merge
# ============================================================
# After do_merge_to_main acquires the lock, _MERGE_LOCK_ACQUIRED_AT
# should be set to a non-negative value (it's set at line 249).
# After release, it should be -1 again.

echo ""
_tlog "=== Test 12: _MERGE_LOCK_ACQUIRED_AT lifecycle during merge ==="

_reset_test_state
_MERGE_LOCK_ACQUIRED_AT=-1

BRANCH_E12="dev/test-lock-ts"
_create_feature_branch "$BRANCH_E12" "lock-ts.txt" "lock timestamp content"

# Override _release_merge_lock_with_duration to capture the timestamp
# before it gets reset.
_captured_lock_ts=-1
_saved_release_fn_e12=$(declare -f _release_merge_lock_with_duration)
_release_merge_lock_with_duration() {
  _captured_lock_ts="$_MERGE_LOCK_ACQUIRED_AT"
  # Call original logic
  local duration
  if [ "$_MERGE_LOCK_ACQUIRED_AT" -ge 0 ] 2>/dev/null; then
    duration=$(( SECONDS - _MERGE_LOCK_ACQUIRED_AT ))
  else
    duration=-1
  fi
  release_merge_lock
  _MERGE_LOCK_ACQUIRED_AT=-1
}

_merge_rc=0
run_merge "$BRANCH_E12" "$WORKTREE_DIR" "$LOG" "false" || _merge_rc=$?
assert_eq "$_merge_rc" "0" "lock-ts: merge succeeded"

# The captured timestamp should be >= 0 (it was set during merge)
if [ "$_captured_lock_ts" -ge 0 ] 2>/dev/null; then
  pass "lock-ts: _MERGE_LOCK_ACQUIRED_AT was set to non-negative value during merge ($_captured_lock_ts)"
else
  fail "lock-ts: _MERGE_LOCK_ACQUIRED_AT should be >= 0 during merge (was $_captured_lock_ts)"
fi

# After merge, it should be reset
assert_eq "$_MERGE_LOCK_ACQUIRED_AT" "-1" "lock-ts: _MERGE_LOCK_ACQUIRED_AT reset to -1 after merge"

# Restore
eval "$_saved_release_fn_e12"

# ============================================================
# TEST 13: Rebase recovery — rebase succeeds but post-rebase merge fails
# ============================================================
# This tests the path at lines 294-298: rebase succeeds, checkout main,
# but the merge STILL fails (e.g., due to another conflict introduced
# during the rebase recovery sequence).

echo ""
_tlog "=== Test 13: Rebase recovery — rebase OK but re-merge fails ==="

_reset_test_state

BRANCH_E13="dev/test-rebase-ok-merge-fail"

# Create a conflict scenario
cd "$PROJECT_DIR"
echo "main content e13" > rebase-remrg.txt
git add rebase-remrg.txt
git commit -m "main: add rebase-remrg.txt" --no-verify >/dev/null 2>&1
git push origin "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1

WORKTREE_DIR="$SKYNET_WORKTREE_BASE/w-test"
cleanup_worktree 2>/dev/null || true
git worktree add "$WORKTREE_DIR" -b "$BRANCH_E13" HEAD~1 >/dev/null 2>&1
cd "$WORKTREE_DIR"
git config user.email "test@merge-edge.test"
git config user.name "Merge Edge Test"
echo "branch content e13" > rebase-remrg.txt
git add rebase-remrg.txt
git commit -m "branch: modify rebase-remrg.txt" --no-verify >/dev/null 2>&1
cd "$PROJECT_DIR"
git checkout "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1

# Override run_with_timeout to let rebase succeed but make the post-rebase
# merge fail. The sequence is:
#   call 1: merge --abort (let it pass)
#   call 2: checkout $branch (let it pass)
#   call 3: rebase main (let it pass — this will actually conflict, but we
#            want to simulate it succeeding)
#   call 4: checkout main (let it pass)
# Then the regular `git merge` at line 294 should fail.
# Since a real conflict exists, this should naturally fail at the merge step.
# However, the rebase will also naturally fail. We need to override it.
_rwt_call_e13=0
_saved_rwt_e13=$(declare -f run_with_timeout 2>/dev/null || true)
run_with_timeout() {
  _rwt_call_e13=$((_rwt_call_e13 + 1))
  shift  # skip timeout arg
  local _cmd_str="$*"

  # Let rebase "succeed" by doing a reset to simulate clean rebase
  if echo "$_cmd_str" | grep -q "rebase"; then
    # Simulate successful rebase: just return 0
    return 0
  fi

  # For everything else, run the actual command
  "$@"
}

: > "$LOG"
_merge_rc=0
run_merge "$BRANCH_E13" "$WORKTREE_DIR" "$LOG" "false" || _merge_rc=$?

# Should fail because even after "successful" rebase, the merge still conflicts
assert_eq "$_merge_rc" "1" "rebase-remrg: returns 1 (merge still fails after rebase)"

REMRG_LOG=$(cat "$LOG" 2>/dev/null)
assert_contains "$REMRG_LOG" "Rebase succeeded" "rebase-remrg: log mentions rebase success"

# Restore
if [ -n "$_saved_rwt_e13" ]; then
  eval "$_saved_rwt_e13"
else
  run_with_timeout() { shift; "$@"; }
fi
cd "$PROJECT_DIR"
git checkout "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1 || true
git merge --abort 2>/dev/null || true
cleanup_worktree "$BRANCH_E13" 2>/dev/null || true

# ============================================================
# TEST 14: _compute_dynamic_merge_ttl — exactly 301 with default base
# ============================================================
# duration=301 → computed = 301*2+300 = 902 > base 900 → sets to 902.

echo ""
_tlog "=== Test 14: _compute_dynamic_merge_ttl — 301 with default base ==="

echo "301" > "${DEV_DIR}/typecheck-duration"
SKYNET_MERGE_LOCK_TTL=900
_compute_dynamic_merge_ttl
assert_eq "$SKYNET_MERGE_LOCK_TTL" "902" "ttl-301-default: duration=301 → TTL 902 (301*2+300, above base 900)"

# Clean up
rm -f "${DEV_DIR}/typecheck-duration"
SKYNET_MERGE_LOCK_TTL=900

# ============================================================
# TEST 15: _merge_push_with_ttl_guard — failure log after all attempts
# ============================================================
# When all push attempts are exhausted, the final error message should
# mention the total attempt count.

echo ""
_tlog "=== Test 15: _merge_push_with_ttl_guard — exhaustion log message ==="

_MERGE_LOCK_ACQUIRED_AT=$SECONDS
SKYNET_MERGE_LOCK_TTL=9999
SKYNET_GIT_PUSH_TIMEOUT=120

_saved_rwt_e15=$(declare -f run_with_timeout 2>/dev/null || true)
run_with_timeout() { return 1; }

: > "$LOG"
_ptg_rc=0
_merge_push_with_ttl_guard 3 || _ptg_rc=$?
assert_eq "$_ptg_rc" "1" "push-exhaust-log: returns 1"

EXHAUST_LOG=$(cat "$LOG" 2>/dev/null)
assert_contains "$EXHAUST_LOG" "git push failed after 3 attempts" "push-exhaust-log: log mentions all 3 attempts exhausted"

# Restore
if [ -n "$_saved_rwt_e15" ]; then
  eval "$_saved_rwt_e15"
else
  run_with_timeout() { shift; "$@"; }
fi
_MERGE_LOCK_ACQUIRED_AT=-1
SKYNET_MERGE_LOCK_TTL=900

# ============================================================
# TEST 16: _compute_dynamic_merge_ttl — file unreadable (cat fallback)
# ============================================================
# When typecheck-duration exists but is unreadable, `cat` fails and
# the `|| echo "0"` fallback kicks in, so TTL stays at default.

echo ""
_tlog "=== Test 16: _compute_dynamic_merge_ttl — unreadable file fallback ==="

echo "500" > "${DEV_DIR}/typecheck-duration"
chmod 000 "${DEV_DIR}/typecheck-duration" 2>/dev/null || true
SKYNET_MERGE_LOCK_TTL=900
_compute_dynamic_merge_ttl

# If chmod succeeded, cat will fail and fallback to 0 → TTL unchanged
# If chmod failed (e.g., running as root), the file is still readable
# and 500 > 300 → TTL = 500*2+300 = 1300. Accept either outcome.
if [ "$SKYNET_MERGE_LOCK_TTL" = "900" ]; then
  pass "ttl-unreadable: unreadable file → fallback to default TTL"
elif [ "$SKYNET_MERGE_LOCK_TTL" = "1300" ]; then
  pass "ttl-unreadable: file was still readable (running as root?) — dynamic TTL computed"
else
  fail "ttl-unreadable: unexpected TTL value $SKYNET_MERGE_LOCK_TTL"
fi

# Clean up
chmod 644 "${DEV_DIR}/typecheck-duration" 2>/dev/null || true
rm -f "${DEV_DIR}/typecheck-duration"
SKYNET_MERGE_LOCK_TTL=900

# ============================================================
# TEST 17: Canary content includes all required fields
# ============================================================
# When canary is triggered, the canary-pending file must contain
# commit=, timestamp=, and files= on separate lines.

echo ""
_tlog "=== Test 17: Canary content — all required fields present ==="

_reset_test_state

BRANCH_E17="dev/test-canary-fields"

cd "$PROJECT_DIR"
git checkout "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1

WORKTREE_DIR="$SKYNET_WORKTREE_BASE/w-test"
cleanup_worktree 2>/dev/null || true
git worktree add "$WORKTREE_DIR" -b "$BRANCH_E17" "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1
cd "$WORKTREE_DIR"
git config user.email "test@merge-edge.test"
git config user.name "Merge Edge Test"
mkdir -p scripts
echo "#!/usr/bin/env bash" > scripts/canary-fields-test.sh
git add scripts/canary-fields-test.sh
git commit -m "feat: add scripts/canary-fields-test.sh" >/dev/null 2>&1
cd "$PROJECT_DIR"
git checkout "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1

export SKYNET_CANARY_ENABLED="true"
rm -f "${DEV_DIR}/canary-pending"

_merge_rc=0
run_merge "$BRANCH_E17" "$WORKTREE_DIR" "$LOG" "false" || _merge_rc=$?
assert_eq "$_merge_rc" "0" "canary-fields: merge succeeded"

if [ -f "${DEV_DIR}/canary-pending" ]; then
  CANARY=$(cat "${DEV_DIR}/canary-pending")
  # Verify commit= is a valid-looking git hash (at least 7 hex chars)
  COMMIT_LINE=$(echo "$CANARY" | grep "^commit=")
  if echo "$COMMIT_LINE" | grep -qE "^commit=[0-9a-f]{7,}"; then
    pass "canary-fields: commit= contains valid git hash"
  else
    fail "canary-fields: commit= should be a git hash (got: $COMMIT_LINE)"
  fi
  # Verify timestamp= is a numeric Unix timestamp
  TS_LINE=$(echo "$CANARY" | grep "^timestamp=")
  if echo "$TS_LINE" | grep -qE "^timestamp=[0-9]+$"; then
    pass "canary-fields: timestamp= is numeric"
  else
    fail "canary-fields: timestamp= should be numeric (got: $TS_LINE)"
  fi
  # Verify files= is non-empty
  FILES_LINE=$(echo "$CANARY" | grep "^files=")
  assert_not_empty "$FILES_LINE" "canary-fields: files= line present"
else
  fail "canary-fields: canary-pending should be created"
  fail "canary-fields: (skip commit check)"
  fail "canary-fields: (skip timestamp check)"
  fail "canary-fields: (skip files check)"
fi

# Reset
export SKYNET_CANARY_ENABLED="false"
rm -f "${DEV_DIR}/canary-pending"

# ============================================================
# TEST 18: _check_merge_lock_ttl — large custom minimum
# ============================================================
# With a large custom minimum that exceeds the TTL, should fail.

echo ""
_tlog "=== Test 18: _check_merge_lock_ttl — large custom minimum ==="

_MERGE_LOCK_ACQUIRED_AT=$SECONDS
SKYNET_MERGE_LOCK_TTL=$(( SECONDS + 500 ))  # remaining=500

_ttl_rc=0
_check_merge_lock_ttl 600 || _ttl_rc=$?
assert_eq "$_ttl_rc" "1" "ttl-large-min: remaining=500, need 600 → returns 1"

# Reset
_MERGE_LOCK_ACQUIRED_AT=-1
SKYNET_MERGE_LOCK_TTL=900

# ============================================================
# TEST 19: _release_merge_lock_with_duration — unknown timestamp warning
# ============================================================
# When _MERGE_LOCK_ACQUIRED_AT is -1 (never acquired), the release
# should log a warning about unknown timestamp and still release.

echo ""
_tlog "=== Test 19: _release_merge_lock_with_duration — unknown timestamp ==="

_reset_test_state

acquire_merge_lock
_MERGE_LOCK_ACQUIRED_AT=-1
: > "$LOG"
_release_merge_lock_with_duration

UNKNOWN_LOG=$(cat "$LOG")
assert_contains "$UNKNOWN_LOG" "acquisition timestamp was not recorded" "unknown-ts: warns about missing timestamp"
assert_not_contains "$UNKNOWN_LOG" "Merge lock held for" "unknown-ts: does NOT log hold duration when timestamp unknown"

# ============================================================
# TEST 20: _merge_push_with_ttl_guard — backoff between retries
# ============================================================
# The backoff doubles: 1s, 2s, 4s... Verify that sleep is called
# between retries (not before first attempt).

echo ""
_tlog "=== Test 20: _merge_push_with_ttl_guard — backoff sleep between retries ==="

_MERGE_LOCK_ACQUIRED_AT=$SECONDS
SKYNET_MERGE_LOCK_TTL=9999
SKYNET_GIT_PUSH_TIMEOUT=120

_sleep_calls_e20=""
_saved_rwt_e20=$(declare -f run_with_timeout 2>/dev/null || true)
run_with_timeout() {
  return 1  # Always fail
}

# Override sleep to track calls
_saved_sleep_e20=$(declare -f sleep 2>/dev/null || true)
sleep() {
  _sleep_calls_e20="${_sleep_calls_e20}${1} "
}

: > "$LOG"
_ptg_rc=0
_merge_push_with_ttl_guard 3 || _ptg_rc=$?

# Sleep should be called with backoff values: 1 (after attempt 1), 2 (after attempt 2)
# Not called after last attempt (no more retries)
assert_contains "$_sleep_calls_e20" "1 " "backoff: sleep 1s after first failure"
assert_contains "$_sleep_calls_e20" "2 " "backoff: sleep 2s after second failure"

# Restore
if [ -n "$_saved_rwt_e20" ]; then
  eval "$_saved_rwt_e20"
else
  run_with_timeout() { shift; "$@"; }
fi
if [ -n "$_saved_sleep_e20" ]; then
  eval "$_saved_sleep_e20"
else
  unset -f sleep
fi
_MERGE_LOCK_ACQUIRED_AT=-1
SKYNET_MERGE_LOCK_TTL=900

# ============================================================
# TEST 21: Post-merge typecheck — log mentions pass and duration
# ============================================================
# When typecheck passes, the log should contain a message with
# "Post-merge typecheck passed" and the elapsed duration.

echo ""
_tlog "=== Test 21: Post-merge typecheck — pass log message ==="

_reset_test_state

BRANCH_E21="dev/test-tc-pass-log"
_create_feature_branch "$BRANCH_E21" "tc-pass-log.txt" "tc pass log content"

export SKYNET_POST_MERGE_TYPECHECK="true"
export SKYNET_TYPECHECK_CMD="true"
: > "$LOG"

_merge_rc=0
run_merge "$BRANCH_E21" "$WORKTREE_DIR" "$LOG" "false" || _merge_rc=$?
assert_eq "$_merge_rc" "0" "tc-pass-log: merge succeeded"

TC_PASS_LOG=$(cat "$LOG" 2>/dev/null)
assert_contains "$TC_PASS_LOG" "Post-merge typecheck passed" "tc-pass-log: log mentions typecheck passed"
# Duration should be in parentheses, e.g., "(0s)" or "(1s)"
if echo "$TC_PASS_LOG" | grep -qE "typecheck passed \([0-9]+s\)"; then
  pass "tc-pass-log: log includes duration in seconds"
else
  fail "tc-pass-log: log should include duration like (Ns)"
fi

# Reset
export SKYNET_POST_MERGE_TYPECHECK="false"
export SKYNET_TYPECHECK_CMD="true"

# ============================================================
# TEST 22: Merge conflict log mentions branch name
# ============================================================
# When merge fails (RC 1), the log should include the branch name
# in the failure message.

echo ""
_tlog "=== Test 22: Merge conflict — log mentions branch name ==="

_reset_test_state

BRANCH_E22="dev/test-conflict-log"

cd "$PROJECT_DIR"
echo "main content e22" > conflict-log.txt
git add conflict-log.txt
git commit -m "main: conflict-log.txt" --no-verify >/dev/null 2>&1
git push origin "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1

WORKTREE_DIR="$SKYNET_WORKTREE_BASE/w-test"
cleanup_worktree 2>/dev/null || true
git worktree add "$WORKTREE_DIR" -b "$BRANCH_E22" HEAD~1 >/dev/null 2>&1
cd "$WORKTREE_DIR"
git config user.email "test@merge-edge.test"
git config user.name "Merge Edge Test"
echo "branch content e22" > conflict-log.txt
git add conflict-log.txt
git commit -m "branch: conflict-log.txt" --no-verify >/dev/null 2>&1
cd "$PROJECT_DIR"
git checkout "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1

: > "$LOG"
_merge_rc=0
run_merge "$BRANCH_E22" "$WORKTREE_DIR" "$LOG" "false" || _merge_rc=$?
assert_eq "$_merge_rc" "1" "conflict-log: returns 1"

CONFLICT_LOG=$(cat "$LOG" 2>/dev/null)
assert_contains "$CONFLICT_LOG" "MERGE FAILED for $BRANCH_E22" "conflict-log: failure log contains branch name"

# Clean up
cd "$PROJECT_DIR"
git checkout "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1 || true
git merge --abort 2>/dev/null || true
cleanup_worktree "$BRANCH_E22" 2>/dev/null || true

# ============================================================
# TEST 23: _compute_dynamic_merge_ttl — negative value in file
# ============================================================
# A negative number contains a "-" which matches *[!0-9]* pattern,
# so it should be treated as non-numeric.

echo ""
_tlog "=== Test 23: _compute_dynamic_merge_ttl — negative value treated as non-numeric ==="

echo "-500" > "${DEV_DIR}/typecheck-duration"
SKYNET_MERGE_LOCK_TTL=900
_compute_dynamic_merge_ttl
assert_eq "$SKYNET_MERGE_LOCK_TTL" "900" "ttl-negative: negative value treated as non-numeric (stays at default)"

# Clean up
rm -f "${DEV_DIR}/typecheck-duration"
SKYNET_MERGE_LOCK_TTL=900

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
