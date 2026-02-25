#!/usr/bin/env bash
# tests/unit/merge-helpers.test.sh — Edge-case unit tests for _merge.sh helpers
#
# Complements merge.test.sh (tests 1-33) with focused boundary/edge-case tests
# for internal helper functions that are difficult to exercise through
# do_merge_to_main() integration tests alone.
#
# Usage: bash tests/unit/merge-helpers.test.sh

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
  rm -rf "/tmp/skynet-test-merge-helpers-$$"* 2>/dev/null || true
  rm -rf "$TMPDIR_ROOT"
}
trap cleanup EXIT

echo ""
_tlog "=== Setup: creating isolated git environment for merge-helpers tests ==="

# Create bare remote and clone
git init --bare "$TMPDIR_ROOT/remote.git" >/dev/null 2>&1
git -C "$TMPDIR_ROOT/remote.git" symbolic-ref HEAD refs/heads/main

git clone "$TMPDIR_ROOT/remote.git" "$TMPDIR_ROOT/project" >/dev/null 2>&1
cd "$TMPDIR_ROOT/project"
git checkout -b main 2>/dev/null || true
git config user.email "test@merge-helpers.test"
git config user.name "Merge Helpers Test"
echo "# Merge Helpers Test Project" > README.md
git add README.md
git commit -m "Initial commit" >/dev/null 2>&1
git push -u origin main >/dev/null 2>&1

# Create .dev/ and config
mkdir -p "$TMPDIR_ROOT/project/.dev"

# Set environment variables
export SKYNET_PROJECT_NAME="test-merge-helpers"
export SKYNET_PROJECT_DIR="$TMPDIR_ROOT/project"
export SKYNET_DEV_DIR="$TMPDIR_ROOT/project/.dev"
export SKYNET_LOCK_PREFIX="/tmp/skynet-test-merge-helpers-$$"
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
export SKYNET_DEV_PORT=13201
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
LOG="$TMPDIR_ROOT/test-merge-helpers.log"
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
  git config user.email "test@merge-helpers.test"
  git config user.name "Merge Helpers Test"
  echo "$content" > "$file_name"
  git add "$file_name"
  git commit -m "feat: add $file_name" >/dev/null 2>&1

  cd "$PROJECT_DIR"
  git checkout "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1
}

# Helper: create a feature branch with a script change (triggers canary)
_create_script_feature_branch() {
  local branch_name="$1"

  cd "$PROJECT_DIR"
  git checkout "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1
  mkdir -p scripts

  WORKTREE_DIR="$SKYNET_WORKTREE_BASE/w-test"
  cleanup_worktree 2>/dev/null || true
  git worktree add "$WORKTREE_DIR" -b "$branch_name" "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1

  cd "$WORKTREE_DIR"
  git config user.email "test@merge-helpers.test"
  git config user.name "Merge Helpers Test"
  mkdir -p scripts
  echo "#!/usr/bin/env bash" > scripts/canary-edge-test.sh
  echo "echo canary-edge" >> scripts/canary-edge-test.sh
  git add scripts/canary-edge-test.sh
  git commit -m "feat: add scripts/canary-edge-test.sh" >/dev/null 2>&1

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

pass "Setup: isolated merge-helpers test environment created"

# ============================================================
# TEST 1: _compute_dynamic_merge_ttl — boundary at exactly 300
# ============================================================
# The condition is `_last_dur -gt 300`, so 300 should NOT trigger
# dynamic TTL computation (it must be strictly > 300).

echo ""
_tlog "=== Test 1: _compute_dynamic_merge_ttl — boundary at exactly 300 ==="

echo "300" > "${DEV_DIR}/typecheck-duration"
SKYNET_MERGE_LOCK_TTL=900
_compute_dynamic_merge_ttl
assert_eq "$SKYNET_MERGE_LOCK_TTL" "900" "ttl-boundary-300: duration=300 does NOT trigger dynamic TTL (>300 required)"

# Clean up
rm -f "${DEV_DIR}/typecheck-duration"
SKYNET_MERGE_LOCK_TTL=900

# ============================================================
# TEST 2: _compute_dynamic_merge_ttl — computed < base TTL (floor)
# ============================================================
# When dur=301, computed = 301*2+300 = 902. With base_ttl=1000,
# the floor should keep TTL at 1000 (not 902).

echo ""
_tlog "=== Test 2: _compute_dynamic_merge_ttl — computed value below base TTL ==="

echo "301" > "${DEV_DIR}/typecheck-duration"
SKYNET_MERGE_LOCK_TTL=1000
_compute_dynamic_merge_ttl
assert_eq "$SKYNET_MERGE_LOCK_TTL" "1000" "ttl-floor: computed 902 stays at base 1000 (floor applied)"

# Clean up
rm -f "${DEV_DIR}/typecheck-duration"
SKYNET_MERGE_LOCK_TTL=900

# ============================================================
# TEST 3: _compute_dynamic_merge_ttl — duration=0
# ============================================================
# Duration of 0 is ≤ 300, so TTL should stay at default.

echo ""
_tlog "=== Test 3: _compute_dynamic_merge_ttl — duration=0 ==="

echo "0" > "${DEV_DIR}/typecheck-duration"
SKYNET_MERGE_LOCK_TTL=900
_compute_dynamic_merge_ttl
assert_eq "$SKYNET_MERGE_LOCK_TTL" "900" "ttl-zero-dur: duration=0 keeps default TTL"

# Clean up
rm -f "${DEV_DIR}/typecheck-duration"
SKYNET_MERGE_LOCK_TTL=900

# ============================================================
# TEST 4: _check_merge_lock_ttl — exact boundary remaining=180, need 180
# ============================================================
# The condition is `_remaining -lt _min_remaining`, so remaining=180
# with min=180 should return 0 (180 is NOT less than 180).

echo ""
_tlog "=== Test 4: _check_merge_lock_ttl — exact boundary (remaining == needed) ==="

# Strategy: set acquired_at=0 and TTL=SECONDS+180, so lock_age=SECONDS,
# remaining = TTL - lock_age = (SECONDS+180) - SECONDS = 180.
# Check: 180 < 180 → false → returns 0 (sufficient).
_MERGE_LOCK_ACQUIRED_AT=0
SKYNET_MERGE_LOCK_TTL=$(( SECONDS + 180 ))

_ttl_rc=0
_check_merge_lock_ttl 180 || _ttl_rc=$?
assert_eq "$_ttl_rc" "0" "ttl-exact-boundary: remaining=180, need 180 → returns 0 (sufficient)"

# Reset
_MERGE_LOCK_ACQUIRED_AT=-1
SKYNET_MERGE_LOCK_TTL=900

# ============================================================
# TEST 5: _check_merge_lock_ttl — one second below boundary
# ============================================================
# remaining=179, need 180 → should return 1 (179 < 180).

echo ""
_tlog "=== Test 5: _check_merge_lock_ttl — one second below boundary ==="

# Strategy: set acquired_at=0 and TTL=SECONDS+179, so lock_age=SECONDS,
# remaining = TTL - lock_age = (SECONDS+179) - SECONDS = 179.
# Check: 179 < 180 → true → returns 1 (insufficient).
_MERGE_LOCK_ACQUIRED_AT=0
SKYNET_MERGE_LOCK_TTL=$(( SECONDS + 179 ))

_ttl_rc=0
_check_merge_lock_ttl 180 || _ttl_rc=$?
assert_eq "$_ttl_rc" "1" "ttl-below-boundary: remaining=179, need 180 → returns 1 (insufficient)"

# Reset
_MERGE_LOCK_ACQUIRED_AT=-1
SKYNET_MERGE_LOCK_TTL=900

# ============================================================
# TEST 6: _release_merge_lock_with_duration — long hold (>300s) warns
# ============================================================

echo ""
_tlog "=== Test 6: _release_merge_lock_with_duration — long hold warning ==="

_reset_test_state

acquire_merge_lock
# SECONDS starts at 0 when the script starts, so SECONDS - 350 may be negative.
# Instead, bump SECONDS temporarily so the math works, then restore it.
_saved_seconds=$SECONDS
SECONDS=500
_MERGE_LOCK_ACQUIRED_AT=$(( SECONDS - 350 ))
: > "$LOG"
_release_merge_lock_with_duration
SECONDS=$_saved_seconds

RELEASE_LOG=$(cat "$LOG")
assert_contains "$RELEASE_LOG" "Merge lock held for" "long-hold: logs hold duration"
assert_contains "$RELEASE_LOG" "WARNING" "long-hold: emits WARNING for >300s hold"
assert_contains "$RELEASE_LOG" ">300s threshold" "long-hold: mentions 300s threshold"

# ============================================================
# TEST 7: _release_merge_lock_with_duration — short hold does NOT warn
# ============================================================

echo ""
_tlog "=== Test 7: _release_merge_lock_with_duration — short hold no warning ==="

_reset_test_state

acquire_merge_lock
# Use SECONDS directly (lock "just acquired") — duration will be ~0s
_MERGE_LOCK_ACQUIRED_AT=$SECONDS
: > "$LOG"
_release_merge_lock_with_duration

RELEASE_LOG=$(cat "$LOG")
assert_contains "$RELEASE_LOG" "Merge lock held for" "short-hold: logs hold duration"
assert_not_contains "$RELEASE_LOG" "WARNING" "short-hold: no WARNING for short hold"

# ============================================================
# TEST 8: Canary NOT triggered when SKYNET_CANARY_ENABLED=false
# ============================================================
# Test 28 in merge.test.sh tests canary NOT triggered for non-script changes.
# This test verifies canary is NOT triggered even for script changes when
# SKYNET_CANARY_ENABLED=false.

echo ""
_tlog "=== Test 8: Canary disabled — script changes do NOT trigger canary ==="

_reset_test_state

BRANCH_8="dev/test-canary-disabled"
_create_script_feature_branch "$BRANCH_8"

export SKYNET_CANARY_ENABLED="false"
rm -f "${DEV_DIR}/canary-pending"

_merge_rc=0
run_merge "$BRANCH_8" "$WORKTREE_DIR" "$LOG" "false" || _merge_rc=$?
assert_eq "$_merge_rc" "0" "canary-disabled: merge succeeded"

if [ ! -f "${DEV_DIR}/canary-pending" ]; then
  pass "canary-disabled: canary-pending NOT created when SKYNET_CANARY_ENABLED=false"
else
  fail "canary-disabled: canary-pending should not exist when canary is disabled"
fi

# Reset
export SKYNET_CANARY_ENABLED="false"
rm -f "${DEV_DIR}/canary-pending"

# ============================================================
# TEST 9: Smoke failure with state commit hook — two-commit revert
# ============================================================
# When _MERGE_STATE_COMMIT_FN succeeds AND smoke test then fails,
# the revert must handle two commits (merge + state commit).
# This exercises _do_revert with state_committed="true" via the
# smoke test failure path in do_merge_to_main().

echo ""
_tlog "=== Test 9: Smoke failure with state commit — two-commit revert ==="

_reset_test_state

BRANCH_9="dev/test-smoke-state-revert"
_create_feature_branch "$BRANCH_9" "smoke-state-file.txt" "smoke state content"

# Define a state commit hook that succeeds and creates a state file
_state_hook_called=false
_test_smoke_state_commit() {
  _state_hook_called=true
  cd "$PROJECT_DIR"
  echo "state-data-for-smoke-test" > state-for-smoke.txt
  git add state-for-smoke.txt
  git commit -m "chore: state update for smoke test" --no-verify >/dev/null 2>&1
  return 0
}

_MERGE_STATE_COMMIT_FN="_test_smoke_state_commit"

# Enable smoke test with a failing script
export SKYNET_POST_MERGE_SMOKE="true"
SKYNET_SCRIPTS_DIR="$TMPDIR_ROOT/scripts-override-helpers"
mkdir -p "$SKYNET_SCRIPTS_DIR"
cat > "$SKYNET_SCRIPTS_DIR/post-merge-smoke.sh" <<'SMOKE'
#!/usr/bin/env bash
exit 1
SMOKE
chmod +x "$SKYNET_SCRIPTS_DIR/post-merge-smoke.sh"

_merge_rc=0
do_merge_to_main "$BRANCH_9" "$WORKTREE_DIR" "$LOG" "false" >>"$LOG" 2>&1 || _merge_rc=$?
set +e

assert_eq "$_merge_rc" "7" "smoke-state-revert: returns 7 (smoke test failed)"

if [ "$_state_hook_called" = "true" ]; then
  pass "smoke-state-revert: state commit hook was called before smoke test"
else
  fail "smoke-state-revert: state commit hook should have been called"
fi

# Verify both files are reverted (merge file + state file)
cd "$PROJECT_DIR"
if [ -f "smoke-state-file.txt" ]; then
  fail "smoke-state-revert: merge file should be reverted"
else
  pass "smoke-state-revert: merge file correctly reverted"
fi
if [ -f "state-for-smoke.txt" ]; then
  fail "smoke-state-revert: state file should be reverted"
else
  pass "smoke-state-revert: state file correctly reverted"
fi

# Verify the revert commit message mentions smoke
LAST_MSG=$(git log -1 --format=%s 2>/dev/null)
assert_contains "$LAST_MSG" "auto-revert" "smoke-state-revert: revert commit has auto-revert tag"
assert_contains "$LAST_MSG" "smoke test failed" "smoke-state-revert: revert commit mentions smoke failure"

# Push to keep remote in sync
git push origin "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1 || true

# Reset
export SKYNET_POST_MERGE_SMOKE="false"
SKYNET_SCRIPTS_DIR="$REPO_ROOT/scripts"

# ============================================================
# TEST 10: _do_revert — reason "typecheck failed" in commit msg
# ============================================================

echo ""
_tlog "=== Test 10: _do_revert — 'typecheck failed' reason in commit message ==="

_reset_test_state

cd "$PROJECT_DIR"
echo "revert-tc-reason" > revert-tc-reason.txt
git add revert-tc-reason.txt
git commit -m "feat: add revert-tc-reason.txt" --no-verify >/dev/null 2>&1

if _do_revert "false" "typecheck failed" "$LOG"; then
  pass "revert-tc-reason: _do_revert succeeded"
else
  fail "revert-tc-reason: _do_revert failed"
fi

LAST_MSG=$(git log -1 --format=%s 2>/dev/null)
assert_contains "$LAST_MSG" "typecheck failed" "revert-tc-reason: commit message contains 'typecheck failed'"
assert_contains "$LAST_MSG" "auto-revert" "revert-tc-reason: commit message contains 'auto-revert'"

# Push to keep remote in sync
git push origin "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1 || true

# ============================================================
# TEST 11: _do_revert — reason "push failed" in commit msg
# ============================================================

echo ""
_tlog "=== Test 11: _do_revert — 'push failed' reason in commit message ==="

_reset_test_state

cd "$PROJECT_DIR"
echo "revert-push-reason" > revert-push-reason.txt
git add revert-push-reason.txt
git commit -m "feat: add revert-push-reason.txt" --no-verify >/dev/null 2>&1

if _do_revert "false" "push failed" "$LOG"; then
  pass "revert-push-reason: _do_revert succeeded"
else
  fail "revert-push-reason: _do_revert failed"
fi

LAST_MSG=$(git log -1 --format=%s 2>/dev/null)
assert_contains "$LAST_MSG" "push failed" "revert-push-reason: commit message contains 'push failed'"
assert_contains "$LAST_MSG" "auto-revert" "revert-push-reason: commit message contains 'auto-revert'"

# Push to keep remote in sync
git push origin "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1 || true

# ============================================================
# TEST 12: _do_revert — reason "smoke test failed" in commit msg
# ============================================================

echo ""
_tlog "=== Test 12: _do_revert — 'smoke test failed' reason in commit message ==="

_reset_test_state

cd "$PROJECT_DIR"
echo "revert-smoke-reason" > revert-smoke-reason.txt
git add revert-smoke-reason.txt
git commit -m "feat: add revert-smoke-reason.txt" --no-verify >/dev/null 2>&1

if _do_revert "false" "smoke test failed" "$LOG"; then
  pass "revert-smoke-reason: _do_revert succeeded"
else
  fail "revert-smoke-reason: _do_revert failed"
fi

LAST_MSG=$(git log -1 --format=%s 2>/dev/null)
assert_contains "$LAST_MSG" "smoke test failed" "revert-smoke-reason: commit message contains 'smoke test failed'"
assert_contains "$LAST_MSG" "auto-revert" "revert-smoke-reason: commit message contains 'auto-revert'"

# Push to keep remote in sync
git push origin "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1 || true

# ============================================================
# TEST 13: _compute_dynamic_merge_ttl — non-numeric with trailing newline
# ============================================================
# Edge case: file contains whitespace or partial numeric content

echo ""
_tlog "=== Test 13: _compute_dynamic_merge_ttl — whitespace in duration file ==="

printf "  450  \n" > "${DEV_DIR}/typecheck-duration"
SKYNET_MERGE_LOCK_TTL=900
_compute_dynamic_merge_ttl
# "  450  " should be treated as non-numeric by case pattern and stay at default
assert_eq "$SKYNET_MERGE_LOCK_TTL" "900" "ttl-whitespace: whitespace-padded value treated as non-numeric (stays at default)"

# Clean up
rm -f "${DEV_DIR}/typecheck-duration"
SKYNET_MERGE_LOCK_TTL=900

# ============================================================
# TEST 14: _compute_dynamic_merge_ttl — cap ceiling (exactly 1800)
# ============================================================
# When computed = 751*2+300 = 1802 > 1800, should cap at 1800.

echo ""
_tlog "=== Test 14: _compute_dynamic_merge_ttl — cap at exactly 1800 ==="

echo "751" > "${DEV_DIR}/typecheck-duration"
SKYNET_MERGE_LOCK_TTL=900
_compute_dynamic_merge_ttl
assert_eq "$SKYNET_MERGE_LOCK_TTL" "1800" "ttl-cap-exact: duration=751 → computed 1802 capped to 1800"

# Clean up
rm -f "${DEV_DIR}/typecheck-duration"
SKYNET_MERGE_LOCK_TTL=900

# ============================================================
# TEST 15: _check_merge_lock_ttl — default minimum (no arg)
# ============================================================
# When called without arguments, default minimum is 180.

echo ""
_tlog "=== Test 15: _check_merge_lock_ttl — default minimum (no arg) ==="

# Set up: acquired at current SECONDS, TTL = SECONDS + 200 → remaining=200
_MERGE_LOCK_ACQUIRED_AT=0
SKYNET_MERGE_LOCK_TTL=$(( SECONDS + 200 ))

_ttl_rc=0
_check_merge_lock_ttl || _ttl_rc=$?
assert_eq "$_ttl_rc" "0" "ttl-default-min: remaining=200 ≥ default 180 → returns 0"

# Now test with remaining=170 < default 180
SKYNET_MERGE_LOCK_TTL=$(( SECONDS + 170 ))
_ttl_rc=0
_check_merge_lock_ttl || _ttl_rc=$?
assert_eq "$_ttl_rc" "1" "ttl-default-min: remaining=170 < default 180 → returns 1"

# Reset
_MERGE_LOCK_ACQUIRED_AT=-1
SKYNET_MERGE_LOCK_TTL=900

# ============================================================
# TEST 16: _merge_push_with_ttl_guard — total elapsed time cap (180s)
# ============================================================
# The push guard caps total elapsed time across all retries at 180s.
# Simulate this by overriding date +%s to return a future timestamp.

echo ""
_tlog "=== Test 16: _merge_push_with_ttl_guard — total elapsed time cap ==="

_MERGE_LOCK_ACQUIRED_AT=$SECONDS
SKYNET_MERGE_LOCK_TTL=9999  # Very large TTL so TTL checks pass
SKYNET_GIT_PUSH_TIMEOUT=120
LOG="$TMPDIR_ROOT/test-merge-helpers.log"

# Override date to simulate time passing beyond 180s after first push attempt.
# We use a file-based counter because $(date +%s) runs in a subshell,
# so shell variable increments don't persist to the parent.
_date_counter_file="$TMPDIR_ROOT/date-counter"
echo "0" > "$_date_counter_file"
_date_initial=$(command date +%s)
date() {
  if [ "$1" = "+%s" ]; then
    local _cnt
    _cnt=$(cat "$_date_counter_file" 2>/dev/null || echo "0")
    _cnt=$((_cnt + 1))
    echo "$_cnt" > "$_date_counter_file"
    # First call returns initial time, subsequent calls return 200s later
    if [ "$_cnt" -le 1 ]; then
      echo "$_date_initial"
    else
      echo $(( _date_initial + 200 ))
    fi
  else
    command date "$@"
  fi
}

# Override run_with_timeout to always fail (simulating push failure)
_saved_rwt_16=$(declare -f run_with_timeout 2>/dev/null || true)
run_with_timeout() { return 1; }

: > "$LOG"
_ptg_rc=0
_merge_push_with_ttl_guard 5 || _ptg_rc=$?
assert_eq "$_ptg_rc" "1" "push-time-cap: returns 1 when total time exceeds 180s"

PUSH_CAP_LOG=$(cat "$LOG" 2>/dev/null)
assert_contains "$PUSH_CAP_LOG" "total time exceeded 180s" "push-time-cap: log mentions 180s cap exceeded"

# Restore
unset -f date
rm -f "$_date_counter_file"
if [ -n "$_saved_rwt_16" ]; then
  eval "$_saved_rwt_16"
else
  run_with_timeout() { shift; "$@"; }
fi
_MERGE_LOCK_ACQUIRED_AT=-1
SKYNET_MERGE_LOCK_TTL=900

# ============================================================
# TEST 17: _do_revert — git revert failure cleans up with reset
# ============================================================
# When git revert fails, _do_revert runs git reset --hard HEAD
# to clean up partial revert state. Tests the SH-P3-1 path.

echo ""
_tlog "=== Test 17: _do_revert — revert failure cleanup ==="

_reset_test_state

cd "$PROJECT_DIR"
# Create a commit that we'll try to revert
echo "revert-fail-content" > revert-fail-test.txt
git add revert-fail-test.txt
git commit -m "feat: add revert-fail-test.txt" --no-verify >/dev/null 2>&1

# Override git to make revert fail
_real_git_17=$(which git)
git() {
  if echo "$*" | grep -q "revert.*--no-commit"; then
    return 1
  fi
  command git "$@"
}

: > "$LOG"
_revert_rc=0
_do_revert "false" "test revert failure" "$LOG" || _revert_rc=$?
assert_eq "$_revert_rc" "1" "revert-fail: _do_revert returns 1 on git revert failure"

REVERT_FAIL_LOG=$(cat "$LOG" 2>/dev/null)
assert_contains "$REVERT_FAIL_LOG" "CRITICAL: git revert failed" "revert-fail: CRITICAL message logged"

# Verify working tree is clean (reset --hard should have cleaned up)
# Use -uno to ignore untracked files (like .dev/ which is always present)
cd "$PROJECT_DIR"
DIRTY_FILES=$(command git status --porcelain -uno 2>/dev/null)
if [ -z "$DIRTY_FILES" ]; then
  pass "revert-fail: working tree clean after revert failure (reset --hard cleanup)"
else
  fail "revert-fail: working tree should be clean after reset --hard ($DIRTY_FILES)"
fi

# Restore
unset -f git
# Push to keep remote in sync
command git push origin "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1 || true

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
