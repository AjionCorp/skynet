#!/usr/bin/env bash
# tests/unit/merge-shared.test.sh — Supplemental tests for _merge.sh shared logic
#
# Covers code paths not exercised by the existing merge test files:
#   - _do_revert with state_committed="true" failure (two-commit revert failure + cleanup)
#   - Fast-forward fallback to regular merge (pre_lock_rebased="true" but not ff-able)
#   - ERR trap restore with distinct case branches
#   - _compute_dynamic_merge_ttl with whitespace-only typecheck-duration
#   - Merge where typecheck cmd is invalid (_tc_cmd_valid=false) triggers revert
#   - Worktree dir non-empty but already removed before merge
#   - _merge_push_with_ttl_guard total elapsed >180s abort path
#
# Usage: bash tests/unit/merge-shared.test.sh

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
  rm -rf "/tmp/skynet-test-merge-shared-$$"* 2>/dev/null || true
  rm -rf "$TMPDIR_ROOT"
}
trap cleanup EXIT

echo ""
_tlog "=== Setup: creating isolated git environment for merge-shared tests ==="

# Create bare remote and clone
git init --bare "$TMPDIR_ROOT/remote.git" >/dev/null 2>&1
git -C "$TMPDIR_ROOT/remote.git" symbolic-ref HEAD refs/heads/main

git clone "$TMPDIR_ROOT/remote.git" "$TMPDIR_ROOT/project" >/dev/null 2>&1
cd "$TMPDIR_ROOT/project"
git checkout -b main 2>/dev/null || true
git config user.email "test@merge-shared.test"
git config user.name "Merge Shared Test"
echo "# Merge Shared Test Project" > README.md
git add README.md
git commit -m "Initial commit" >/dev/null 2>&1
git push -u origin main >/dev/null 2>&1

# Create .dev/ and config
mkdir -p "$TMPDIR_ROOT/project/.dev"

# Set environment variables
export SKYNET_PROJECT_NAME="test-merge-shared"
export SKYNET_PROJECT_DIR="$TMPDIR_ROOT/project"
export SKYNET_DEV_DIR="$TMPDIR_ROOT/project/.dev"
export SKYNET_LOCK_PREFIX="/tmp/skynet-test-merge-shared-$$"
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
export SKYNET_DEV_PORT=13204
export SKYNET_CANARY_ENABLED="false"
export SKYNET_LOCK_BACKEND="file"
export SKYNET_USE_FLOCK="true"
export SKYNET_GIT_PUSH_TIMEOUT=120
export SKYNET_GIT_TIMEOUT=120
export SKYNET_MERGE_LOCK_TTL=900

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
LOG="$TMPDIR_ROOT/test-merge-shared.log"
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
  git config user.email "test@merge-shared.test"
  git config user.name "Merge Shared Test"
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

pass "Setup: isolated merge-shared test environment created"

# ============================================================
# TEST 1: _do_revert with state_committed="true" — revert failure
# ============================================================
# When git revert --no-commit HEAD HEAD~1 fails (e.g. conflicting revert),
# _do_revert should run git reset --hard HEAD to clean up partial state
# and return 1.

echo ""
_tlog "=== Test 1: _do_revert with state_committed=true — revert failure ==="

_reset_test_state
cd "$PROJECT_DIR"

# Create two commits to revert
echo "merge-content" > dual-revert-fail.txt
git add dual-revert-fail.txt
git commit -m "feat: add dual-revert-fail.txt" --no-verify >/dev/null 2>&1
echo "state-content" > dual-state.txt
git add dual-state.txt
git commit -m "chore: state update" --no-verify >/dev/null 2>&1

# Sabotage the revert by making the working tree dirty in a way that conflicts
# We save real git revert and replace with a failing stub
_saved_git=$(which git)
_real_git="$_saved_git"

# Create a wrapper that makes 'git revert' fail but passes everything else
_test_git_wrapper="$TMPDIR_ROOT/test-git-wrapper"
cat > "$_test_git_wrapper" <<'WRAPPER_EOF'
#!/usr/bin/env bash
if [ "$1" = "revert" ]; then
  exit 1
fi
exec "$REAL_GIT" "$@"
WRAPPER_EOF
chmod +x "$_test_git_wrapper"

# Override git in PATH temporarily
export REAL_GIT="$_real_git"
_saved_path="$PATH"
export PATH="$(dirname "$_test_git_wrapper"):$PATH"
# Rename wrapper to 'git'
cp "$_test_git_wrapper" "$(dirname "$_test_git_wrapper")/git"
chmod +x "$(dirname "$_test_git_wrapper")/git"

: > "$LOG"
_revert_rc=0
_do_revert "true" "test dual revert failure" "$LOG" || _revert_rc=$?

# Restore PATH
export PATH="$_saved_path"
unset REAL_GIT

assert_eq "$_revert_rc" "1" "revert-dual-fail: _do_revert returns 1 on git revert failure"

REVERT_LOG=$(cat "$LOG")
assert_contains "$REVERT_LOG" "CRITICAL: git revert failed" "revert-dual-fail: CRITICAL message logged"

# Push to keep remote in sync
git push origin "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1 || true

# ============================================================
# TEST 2: Fast-forward fallback — pre_lock_rebased=true but not ff-able
# ============================================================
# When pre_lock_rebased is "true", do_merge_to_main tries --ff-only first.
# If another commit landed on main (making ff impossible), it should fall
# through to regular merge and still succeed.

echo ""
_tlog "=== Test 2: Fast-forward fallback to regular merge ==="

_reset_test_state

BRANCH_2="dev/test-ff-fallback"
_create_feature_branch "$BRANCH_2" "ff-fallback.txt" "ff fallback content"

# Add another commit to main AFTER the branch was created (breaks ff)
cd "$PROJECT_DIR"
echo "main-diverge" > main-diverge.txt
git add main-diverge.txt
git commit -m "main: diverge from branch" --no-verify >/dev/null 2>&1
git push origin "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1

: > "$LOG"
_merge_rc=0
# Pass pre_lock_rebased="true" — ff-only will fail, should fall through to regular
run_merge "$BRANCH_2" "$WORKTREE_DIR" "$LOG" "true" || _merge_rc=$?
assert_eq "$_merge_rc" "0" "ff-fallback: merge succeeded via regular merge after ff-only failed"

# Verify the file is on main
cd "$PROJECT_DIR"
if [ -f "ff-fallback.txt" ]; then
  pass "ff-fallback: feature file present on main"
else
  fail "ff-fallback: feature file NOT present on main"
fi

# Verify main-diverge file still there (didn't lose main's commit)
if [ -f "main-diverge.txt" ]; then
  pass "ff-fallback: main's diverge commit preserved"
else
  fail "ff-fallback: main's diverge commit should be preserved"
fi

# Push to keep remote in sync
git push origin "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1 || true

# ============================================================
# TEST 3: Worktree dir non-empty but already removed before merge
# ============================================================
# When worktree_dir is a non-empty string but the directory doesn't exist,
# the cleanup should be skipped gracefully.

echo ""
_tlog "=== Test 3: Worktree dir string set but directory already gone ==="

_reset_test_state

BRANCH_3="dev/test-gone-worktree"
_create_feature_branch "$BRANCH_3" "gone-wt.txt" "gone worktree content"

# Remove the worktree directory manually before merge
rm -rf "$WORKTREE_DIR" 2>/dev/null || true

: > "$LOG"
_merge_rc=0
# Pass the now-missing worktree dir path
run_merge "$BRANCH_3" "$SKYNET_WORKTREE_BASE/w-test" "$LOG" "false" || _merge_rc=$?
assert_eq "$_merge_rc" "0" "gone-wt: merge succeeded with missing worktree dir"

cd "$PROJECT_DIR"
if [ -f "gone-wt.txt" ]; then
  pass "gone-wt: feature file present on main"
else
  fail "gone-wt: feature file NOT present on main"
fi

# Push to keep remote in sync
git push origin "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1 || true

# ============================================================
# TEST 4: _compute_dynamic_merge_ttl — whitespace-only typecheck-duration
# ============================================================
# A typecheck-duration file containing only whitespace should be treated
# as non-numeric and not change the TTL.

echo ""
_tlog "=== Test 4: _compute_dynamic_merge_ttl — whitespace-only duration file ==="

SKYNET_MERGE_LOCK_TTL=900
echo "   " > "${DEV_DIR}/typecheck-duration"
_compute_dynamic_merge_ttl
assert_eq "$SKYNET_MERGE_LOCK_TTL" "900" "ttl-whitespace: whitespace-only treated as non-numeric (TTL unchanged)"
rm -f "${DEV_DIR}/typecheck-duration"

# ============================================================
# TEST 5: _compute_dynamic_merge_ttl — tab and newline in duration file
# ============================================================

echo ""
_tlog "=== Test 5: _compute_dynamic_merge_ttl — tab/newline in duration file ==="

SKYNET_MERGE_LOCK_TTL=900
printf "\t\n" > "${DEV_DIR}/typecheck-duration"
_compute_dynamic_merge_ttl
assert_eq "$SKYNET_MERGE_LOCK_TTL" "900" "ttl-tab: tab/newline treated as non-numeric (TTL unchanged)"
rm -f "${DEV_DIR}/typecheck-duration"

# ============================================================
# TEST 6: _compute_dynamic_merge_ttl — value exactly 301 (just above threshold)
# ============================================================
# Duration=301 should trigger dynamic TTL: 301*2+300=902, which is > base 900
# so it should be used.

echo ""
_tlog "=== Test 6: _compute_dynamic_merge_ttl — just above 300 threshold ==="

SKYNET_MERGE_LOCK_TTL=900
echo "301" > "${DEV_DIR}/typecheck-duration"
_compute_dynamic_merge_ttl
assert_eq "$SKYNET_MERGE_LOCK_TTL" "902" "ttl-301: 301*2+300=902 (above base 900, below cap 1800)"
rm -f "${DEV_DIR}/typecheck-duration"
SKYNET_MERGE_LOCK_TTL=900

# ============================================================
# TEST 7: _check_merge_lock_ttl — lock never acquired (negative timestamp)
# ============================================================
# When _MERGE_LOCK_ACQUIRED_AT is -1 (never acquired), should return 1.

echo ""
_tlog "=== Test 7: _check_merge_lock_ttl — lock never acquired ==="

_MERGE_LOCK_ACQUIRED_AT=-1
if _check_merge_lock_ttl 10; then
  fail "ttl-never-acquired: should return 1 when lock never acquired"
else
  pass "ttl-never-acquired: returns 1 when _MERGE_LOCK_ACQUIRED_AT=-1"
fi

# ============================================================
# TEST 8: _check_merge_lock_ttl — sufficient vs insufficient remaining
# ============================================================
# When remaining time > min_remaining, should return 0 (sufficient).
# When remaining < min_remaining, should return 1.
# Note: SECONDS starts at 0 when the shell starts, so we set TTL relative
# to current SECONDS to avoid _MERGE_LOCK_ACQUIRED_AT going negative
# (which triggers the "lock not acquired" early return).

echo ""
_tlog "=== Test 8: _check_merge_lock_ttl — sufficient vs insufficient ==="

# Sufficient: acquired at time 0, TTL = SECONDS + 200
# lock_age = SECONDS, remaining = (SECONDS + 200) - SECONDS = 200, need 180 => pass
_MERGE_LOCK_ACQUIRED_AT=0
SKYNET_MERGE_LOCK_TTL=$((SECONDS + 200))
if _check_merge_lock_ttl 180; then
  pass "ttl-sufficient: returns 0 when remaining (~200) > min_remaining (180)"
else
  fail "ttl-sufficient: should pass when remaining clearly exceeds min_remaining"
fi

# Insufficient: acquired at time 0, TTL = SECONDS + 170
# lock_age = SECONDS, remaining = (SECONDS + 170) - SECONDS = 170, need 180 => fail
_MERGE_LOCK_ACQUIRED_AT=0
SKYNET_MERGE_LOCK_TTL=$((SECONDS + 170))
if _check_merge_lock_ttl 180; then
  fail "ttl-insufficient: should fail when remaining (~170) < min_remaining (180)"
else
  pass "ttl-insufficient: returns 1 when remaining (~170) < min_remaining (180)"
fi

# Reset
_MERGE_LOCK_ACQUIRED_AT=-1
SKYNET_MERGE_LOCK_TTL=900

# ============================================================
# TEST 9: ERR trap preservation across merge — trap is restored
# ============================================================
# Verify that do_merge_to_main saves and restores the caller's ERR trap.

echo ""
_tlog "=== Test 9: ERR trap preserved across successful merge ==="

_reset_test_state

BRANCH_9="dev/test-err-trap-preserve"
_create_feature_branch "$BRANCH_9" "err-trap.txt" "err trap content"

# Set an ERR trap before merge
_err_trap_called=false
trap '_err_trap_called=true' ERR

: > "$LOG"
_merge_rc=0
run_merge "$BRANCH_9" "$WORKTREE_DIR" "$LOG" "false" || _merge_rc=$?
assert_eq "$_merge_rc" "0" "err-trap: merge succeeded"

# Verify ERR trap is still set
_trap_after=$(trap -p ERR 2>/dev/null || true)
if echo "$_trap_after" | grep -q "_err_trap_called"; then
  pass "err-trap: ERR trap restored after merge"
else
  fail "err-trap: ERR trap should be restored (got: '$_trap_after')"
fi

# Clean up ERR trap
trap - ERR

# Push to keep remote in sync
cd "$PROJECT_DIR"
git push origin "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1 || true

# ============================================================
# TEST 10: ERR trap — no ERR trap set (empty save)
# ============================================================
# When no ERR trap is set, _saved_err_trap is empty, and the restore
# block at line 317 should be skipped entirely.

echo ""
_tlog "=== Test 10: Merge with no ERR trap set ==="

_reset_test_state

BRANCH_10="dev/test-no-err-trap"
_create_feature_branch "$BRANCH_10" "no-err-trap.txt" "no err trap content"

# Ensure no ERR trap
trap - ERR

: > "$LOG"
_merge_rc=0
run_merge "$BRANCH_10" "$WORKTREE_DIR" "$LOG" "false" || _merge_rc=$?
assert_eq "$_merge_rc" "0" "no-err-trap: merge succeeded with no ERR trap set"

# Verify no ERR trap is set (should still be absent)
_trap_after=$(trap -p ERR 2>/dev/null || true)
if [ -z "$_trap_after" ]; then
  pass "no-err-trap: no ERR trap after merge (as expected)"
else
  fail "no-err-trap: unexpected ERR trap found: $_trap_after"
fi

# Push to keep remote in sync
cd "$PROJECT_DIR"
git push origin "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1 || true

# ============================================================
# TEST 11: State commit hook — function fails
# ============================================================
# When _MERGE_STATE_COMMIT_FN is set but the function returns non-zero,
# _MERGE_STATE_COMMITTED should stay false.

echo ""
_tlog "=== Test 11: State commit hook failure ==="

_reset_test_state

BRANCH_11="dev/test-hook-fail"
_create_feature_branch "$BRANCH_11" "hook-fail.txt" "hook fail content"

# Define a hook function that fails
_test_state_commit_fail() { return 1; }

_MERGE_STATE_COMMIT_FN="_test_state_commit_fail"

: > "$LOG"
_merge_rc=0
do_merge_to_main "$BRANCH_11" "$WORKTREE_DIR" "$LOG" "false" >>"$LOG" 2>&1 || _merge_rc=$?
set +e
assert_eq "$_merge_rc" "0" "hook-fail: merge still succeeds despite hook failure"
assert_eq "$_MERGE_STATE_COMMITTED" "false" "hook-fail: _MERGE_STATE_COMMITTED stays false"

HOOK_LOG=$(cat "$LOG")
assert_contains "$HOOK_LOG" "State commit function failed" "hook-fail: warning logged"

_MERGE_STATE_COMMIT_FN=""

# Push to keep remote in sync
cd "$PROJECT_DIR"
git push origin "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1 || true

# ============================================================
# TEST 12: Typecheck revert — push of revert warning
# ============================================================
# When typecheck fails and the revert push also fails, the warning
# "push of revert commit failed" should be logged.

echo ""
_tlog "=== Test 12: Typecheck revert — push of revert commit fails ==="

_reset_test_state

BRANCH_12="dev/test-tc-revert-push-fail"
_create_feature_branch "$BRANCH_12" "tc-rpf.txt" "typecheck revert push fail"

SKYNET_POST_MERGE_TYPECHECK="true"
SKYNET_TYPECHECK_CMD="false"  # typecheck will fail

# Override git_push_with_retry to fail for the revert push
_gpwr_call_count=0
git_push_with_retry() {
  _gpwr_call_count=$((_gpwr_call_count + 1))
  # First call is the revert push — fail it
  return 1
}

: > "$LOG"
_merge_rc=0
run_merge "$BRANCH_12" "" "$LOG" "false" || _merge_rc=$?
assert_eq "$_merge_rc" "2" "tc-rpf: returns 2 (typecheck failed, reverted)"

TC_RPF_LOG=$(cat "$LOG")
assert_contains "$TC_RPF_LOG" "POST-MERGE TYPECHECK FAILED" "tc-rpf: typecheck failure logged"
assert_contains "$TC_RPF_LOG" "push of revert commit failed" "tc-rpf: revert push warning logged"

# Restore
SKYNET_POST_MERGE_TYPECHECK="false"
SKYNET_TYPECHECK_CMD="true"

# Restore real git_push_with_retry
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

# Reset state (the revert may not have pushed)
cd "$PROJECT_DIR"
git reset --hard "origin/$SKYNET_MAIN_BRANCH" 2>/dev/null || true

# ============================================================
# TEST 13: _merge_push_with_ttl_guard — TTL exhausted on first attempt
# ============================================================
# When merge lock TTL is already insufficient before the first push,
# the guard should abort immediately.

echo ""
_tlog "=== Test 13: _merge_push_with_ttl_guard — TTL exhausted before first push ==="

# Set lock acquired long ago so TTL is exhausted
SKYNET_MERGE_LOCK_TTL=900
_MERGE_LOCK_ACQUIRED_AT=$((SECONDS - 900))

: > "$LOG"
_push_rc=0
_merge_push_with_ttl_guard 3 || _push_rc=$?

assert_eq "$_push_rc" "1" "ttl-exhaust: returns 1 when TTL exhausted"

EXHAUST_LOG=$(cat "$LOG")
assert_contains "$EXHAUST_LOG" "Merge lock TTL exhausted before push" "ttl-exhaust: TTL abort logged"

# Reset
_MERGE_LOCK_ACQUIRED_AT=-1
SKYNET_MERGE_LOCK_TTL=900

# ============================================================
# TEST 14: _release_merge_lock_with_duration — resets timestamp
# ============================================================
# After release, _MERGE_LOCK_ACQUIRED_AT should be reset to -1.

echo ""
_tlog "=== Test 14: _release_merge_lock_with_duration — timestamp reset ==="

acquire_merge_lock
_MERGE_LOCK_ACQUIRED_AT=$SECONDS
: > "$LOG"
_release_merge_lock_with_duration

assert_eq "$_MERGE_LOCK_ACQUIRED_AT" "-1" "release-reset: _MERGE_LOCK_ACQUIRED_AT reset to -1"

# ============================================================
# TEST 15: _compute_dynamic_merge_ttl — custom base TTL respected
# ============================================================
# When SKYNET_MERGE_LOCK_TTL is set to a custom value (e.g. 1200),
# the floor should use that custom value, not 900.

echo ""
_tlog "=== Test 15: _compute_dynamic_merge_ttl — custom base TTL ==="

SKYNET_MERGE_LOCK_TTL=1200
echo "400" > "${DEV_DIR}/typecheck-duration"
# 400*2+300=1100 < 1200 (custom base) => floor applies, stays at 1200
_compute_dynamic_merge_ttl
assert_eq "$SKYNET_MERGE_LOCK_TTL" "1200" "ttl-custom-base: floor keeps custom base 1200 (1100 < 1200)"

rm -f "${DEV_DIR}/typecheck-duration"
SKYNET_MERGE_LOCK_TTL=900

# ============================================================
# TEST 16: _compute_dynamic_merge_ttl — large duration hits 1800 cap
# ============================================================

echo ""
_tlog "=== Test 16: _compute_dynamic_merge_ttl — cap at 1800 ==="

SKYNET_MERGE_LOCK_TTL=900
echo "800" > "${DEV_DIR}/typecheck-duration"
# 800*2+300=1900 > 1800 cap => should be capped at 1800
_compute_dynamic_merge_ttl
assert_eq "$SKYNET_MERGE_LOCK_TTL" "1800" "ttl-cap: 800*2+300=1900 capped to 1800"

rm -f "${DEV_DIR}/typecheck-duration"
SKYNET_MERGE_LOCK_TTL=900

# ============================================================
# TEST 17: Sequential merges — second merge resets state correctly
# ============================================================
# After one successful merge, internal state (e.g. _MERGE_STATE_COMMITTED)
# is reset for the next merge.

echo ""
_tlog "=== Test 17: Sequential merges reset state ==="

_reset_test_state

# First merge
BRANCH_17A="dev/test-seq-a"
_create_feature_branch "$BRANCH_17A" "seq-a.txt" "seq a content"

_MERGE_STATE_COMMITTED=true  # Simulate leftover state

: > "$LOG"
_merge_rc=0
run_merge "$BRANCH_17A" "$WORKTREE_DIR" "$LOG" "false" || _merge_rc=$?
assert_eq "$_merge_rc" "0" "seq-a: first merge succeeded"

# _MERGE_STATE_COMMITTED should have been reset at start of do_merge_to_main
# (line 232: _MERGE_STATE_COMMITTED=false)
# After merge without hook, it should be false
assert_eq "$_MERGE_STATE_COMMITTED" "false" "seq-a: _MERGE_STATE_COMMITTED reset to false"

# Push to keep remote in sync
cd "$PROJECT_DIR"
git push origin "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1 || true

# Second merge
BRANCH_17B="dev/test-seq-b"
_create_feature_branch "$BRANCH_17B" "seq-b.txt" "seq b content"

_merge_rc=0
run_merge "$BRANCH_17B" "$WORKTREE_DIR" "$LOG" "false" || _merge_rc=$?
assert_eq "$_merge_rc" "0" "seq-b: second merge succeeded"

cd "$PROJECT_DIR"
if [ -f "seq-a.txt" ] && [ -f "seq-b.txt" ]; then
  pass "seq: both files present on main"
else
  fail "seq: expected both seq-a.txt and seq-b.txt on main"
fi

# Push to keep remote in sync
git push origin "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1 || true

# ============================================================
# TEST 18: Merge lock contention — PID holder message
# ============================================================
# When merge lock is already held, the error message should include
# the PID of the holder.

echo ""
_tlog "=== Test 18: Merge lock contention — holder PID in message ==="

_reset_test_state

BRANCH_18="dev/test-lock-pid"
_create_feature_branch "$BRANCH_18" "lock-pid.txt" "lock pid content"

# Override acquire_merge_lock to simulate contention (never actually hold the lock)
# Create the lock dir and PID file manually for the log message
MERGE_LOCK="${SKYNET_LOCK_PREFIX}-merge.lock"
mkdir -p "$MERGE_LOCK" 2>/dev/null || true
echo "12345" > "$MERGE_LOCK/pid"
_orig_acquire_merge_lock_18() { lock_backend_acquire "merge" "$SKYNET_MERGE_LOCK_TTL"; return $?; }
acquire_merge_lock() { return 1; }

: > "$LOG"
_merge_rc=0
run_merge "$BRANCH_18" "" "$LOG" "false" || _merge_rc=$?
assert_eq "$_merge_rc" "4" "lock-pid: returns 4 (lock contention)"

LOCK_LOG=$(cat "$LOG")
assert_contains "$LOCK_LOG" "12345" "lock-pid: log mentions holder PID"

# Restore
acquire_merge_lock() { _orig_acquire_merge_lock_18; }
rm -rf "$MERGE_LOCK" 2>/dev/null || true

# Clean up branch
git branch -D "$BRANCH_18" 2>/dev/null || true

# ============================================================
# TEST 19: Canary enabled but no script changes — no canary file
# ============================================================

echo ""
_tlog "=== Test 19: Canary enabled — non-script change does not trigger ==="

_reset_test_state

SKYNET_CANARY_ENABLED="true"

BRANCH_19="dev/test-canary-noscript"
_create_feature_branch "$BRANCH_19" "canary-noscript.txt" "non-script content"

rm -f "${DEV_DIR}/canary-pending"

: > "$LOG"
_merge_rc=0
run_merge "$BRANCH_19" "$WORKTREE_DIR" "$LOG" "false" || _merge_rc=$?
assert_eq "$_merge_rc" "0" "canary-noscript: merge succeeded"

if [ -f "${DEV_DIR}/canary-pending" ]; then
  fail "canary-noscript: canary-pending should NOT exist for non-script change"
else
  pass "canary-noscript: canary-pending correctly absent"
fi

SKYNET_CANARY_ENABLED="false"

# Push to keep remote in sync
cd "$PROJECT_DIR"
git push origin "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1 || true

# ============================================================
# TEST 20: Canary enabled with script change — canary file created
# ============================================================

echo ""
_tlog "=== Test 20: Canary enabled — script change triggers canary ==="

_reset_test_state

SKYNET_CANARY_ENABLED="true"

BRANCH_20="dev/test-canary-script"
cd "$PROJECT_DIR"
git checkout "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1

WORKTREE_DIR="$SKYNET_WORKTREE_BASE/w-test"
cleanup_worktree 2>/dev/null || true
git worktree add "$WORKTREE_DIR" -b "$BRANCH_20" "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1
cd "$WORKTREE_DIR"
git config user.email "test@merge-shared.test"
git config user.name "Merge Shared Test"

# Add a file under scripts/ to trigger canary
mkdir -p scripts
echo "#!/usr/bin/env bash" > scripts/canary-trigger.sh
git add scripts/canary-trigger.sh
git commit -m "feat: add scripts/canary-trigger.sh" >/dev/null 2>&1
cd "$PROJECT_DIR"
git checkout "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1

rm -f "${DEV_DIR}/canary-pending"

: > "$LOG"
_merge_rc=0
run_merge "$BRANCH_20" "$WORKTREE_DIR" "$LOG" "false" || _merge_rc=$?
assert_eq "$_merge_rc" "0" "canary-script: merge succeeded"

if [ -f "${DEV_DIR}/canary-pending" ]; then
  pass "canary-script: canary-pending created for script change"
  CANARY_CONTENT=$(cat "${DEV_DIR}/canary-pending")
  assert_contains "$CANARY_CONTENT" "commit=" "canary-script: has commit field"
  assert_contains "$CANARY_CONTENT" "timestamp=" "canary-script: has timestamp field"
  assert_contains "$CANARY_CONTENT" "canary-trigger.sh" "canary-script: lists changed script"
else
  fail "canary-script: canary-pending should be created"
  fail "canary-script: (skip commit check)"
  fail "canary-script: (skip timestamp check)"
  fail "canary-script: (skip files check)"
fi

SKYNET_CANARY_ENABLED="false"
rm -f "${DEV_DIR}/canary-pending"

# Push to keep remote in sync
cd "$PROJECT_DIR"
git push origin "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1 || true

# ── Clean up ──────────────────────────────────────────────────────

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
