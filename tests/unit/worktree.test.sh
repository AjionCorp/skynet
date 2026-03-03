#!/usr/bin/env bash
# tests/unit/worktree.test.sh — Unit tests for scripts/_worktree.sh
#
# Tests setup_worktree(), cleanup_worktree(), WORKTREE_LAST_ERROR tracking,
# stale branch deletion, and install command validation.
#
# Usage: bash tests/unit/worktree.test.sh

# NOTE: -e is intentionally omitted — the test uses its own PASS/FAIL counters
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PASS=0
FAIL=0

_tlog()  { printf "  %s\n" "$*"; }
pass() { PASS=$((PASS + 1)); printf "  \033[32m✓\033[0m %s\n" "$*"; }
fail() { FAIL=$((FAIL + 1)); printf "  \033[31m✗\033[0m %s\n" "$*"; }

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

# ── Setup: create isolated git environment ──────────────────────────

TMPDIR_ROOT=$(mktemp -d)
cleanup() {
  rm -rf "$TMPDIR_ROOT"
}
trap cleanup EXIT

echo ""
_tlog "=== Setup: creating isolated git environment for worktree tests ==="

# Create bare remote and clone
git init --bare "$TMPDIR_ROOT/remote.git" >/dev/null 2>&1
git -C "$TMPDIR_ROOT/remote.git" symbolic-ref HEAD refs/heads/main

git clone "$TMPDIR_ROOT/remote.git" "$TMPDIR_ROOT/project" >/dev/null 2>&1
cd "$TMPDIR_ROOT/project"
git checkout -b main 2>/dev/null || true
git config user.email "test@worktree.test"
git config user.name "Worktree Test"
echo "# Worktree Test Project" > README.md
git add README.md
git commit -m "Initial commit" >/dev/null 2>&1
git push -u origin main >/dev/null 2>&1

# Set required variables for _worktree.sh
PROJECT_DIR="$TMPDIR_ROOT/project"
SKYNET_MAIN_BRANCH="main"
SKYNET_WORKTREE_BASE="$TMPDIR_ROOT/worktrees"
WORKTREE_DIR="$SKYNET_WORKTREE_BASE/w-test"
LOG="$TMPDIR_ROOT/test.log"
: > "$LOG"

# Stub log() — _worktree.sh calls this
log() { echo "[$(date '+%H:%M:%S')] $*" >> "$LOG"; }

# Use 'true' as install command for fast tests
export SKYNET_INSTALL_CMD="true"

# Source the module under test
source "$REPO_ROOT/scripts/_worktree.sh"

pass "Setup: isolated worktree test environment created"

# Helper: reset between tests
_reset_wt() {
  cd "$PROJECT_DIR"
  git checkout "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1 || true
  if [ -d "$WORKTREE_DIR" ]; then
    git worktree remove "$WORKTREE_DIR" --force 2>/dev/null || rm -rf "$WORKTREE_DIR" 2>/dev/null || true
  fi
  git worktree prune 2>/dev/null || true
  WORKTREE_LAST_ERROR=""
  unset WORKTREE_DELETE_STALE_BRANCH 2>/dev/null || true
  unset WORKTREE_INSTALL_STRICT 2>/dev/null || true
  export SKYNET_INSTALL_CMD="true"
}

# ============================================================
# TEST 1: setup_worktree — new branch from main (default)
# ============================================================

echo ""
_tlog "=== Test 1: setup_worktree — new branch from main ==="

_reset_wt
# Delete branch if it exists from a prior run
git branch -D "dev/wt-new-branch" 2>/dev/null || true

setup_worktree "dev/wt-new-branch" true
_rc=$?

assert_eq "$_rc" "0" "setup(from_main): returns 0 on success"
[ -d "$WORKTREE_DIR" ] && pass "setup(from_main): worktree directory created" \
                       || fail "setup(from_main): worktree directory not created"

# Verify feature branch exists
if git show-ref --verify --quiet "refs/heads/dev/wt-new-branch" 2>/dev/null; then
  pass "setup(from_main): feature branch created"
else
  fail "setup(from_main): feature branch not created"
fi

# Verify worktree is on the correct branch
WT_BRANCH=$(cd "$WORKTREE_DIR" && git rev-parse --abbrev-ref HEAD 2>/dev/null)
assert_eq "$WT_BRANCH" "dev/wt-new-branch" "setup(from_main): worktree on correct branch"

assert_empty "$WORKTREE_LAST_ERROR" "setup(from_main): no error set"

cleanup_worktree "dev/wt-new-branch"

# ============================================================
# TEST 2: setup_worktree — existing branch (from_main=false)
# ============================================================

echo ""
_tlog "=== Test 2: setup_worktree — existing branch ==="

_reset_wt

# Create the branch first
cd "$PROJECT_DIR"
git branch "dev/wt-existing" "$SKYNET_MAIN_BRANCH" 2>/dev/null

setup_worktree "dev/wt-existing" false
_rc=$?

assert_eq "$_rc" "0" "setup(existing): returns 0 on success"
[ -d "$WORKTREE_DIR" ] && pass "setup(existing): worktree directory created" \
                       || fail "setup(existing): worktree directory not created"

WT_BRANCH=$(cd "$WORKTREE_DIR" && git rev-parse --abbrev-ref HEAD 2>/dev/null)
assert_eq "$WT_BRANCH" "dev/wt-existing" "setup(existing): worktree on correct branch"

assert_empty "$WORKTREE_LAST_ERROR" "setup(existing): no error set"

cleanup_worktree "dev/wt-existing"

# ============================================================
# TEST 3: setup_worktree — cleans leftover worktree before creating
# ============================================================

echo ""
_tlog "=== Test 3: setup_worktree — cleans leftover worktree ==="

_reset_wt
git branch -D "dev/wt-leftover-old" 2>/dev/null || true
git branch -D "dev/wt-leftover-new" 2>/dev/null || true

# Create a worktree manually to simulate a leftover
git worktree add "$WORKTREE_DIR" -b "dev/wt-leftover-old" "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1
[ -d "$WORKTREE_DIR" ] && pass "leftover: pre-existing worktree created" \
                       || fail "leftover: could not create pre-existing worktree"

# setup_worktree should clean it up and create a new one
setup_worktree "dev/wt-leftover-new" true
_rc=$?

assert_eq "$_rc" "0" "leftover: setup succeeds despite leftover"
WT_BRANCH=$(cd "$WORKTREE_DIR" && git rev-parse --abbrev-ref HEAD 2>/dev/null)
assert_eq "$WT_BRANCH" "dev/wt-leftover-new" "leftover: worktree on new branch"

cleanup_worktree "dev/wt-leftover-new"
git branch -D "dev/wt-leftover-old" 2>/dev/null || true

# ============================================================
# TEST 4: setup_worktree — WORKTREE_LAST_ERROR = branch_in_use
# ============================================================

echo ""
_tlog "=== Test 4: setup_worktree — branch_in_use error ==="

_reset_wt
git branch -D "dev/wt-inuse" 2>/dev/null || true

# Create a worktree using the branch in a DIFFERENT location
OTHER_WT="$SKYNET_WORKTREE_BASE/w-other"
git worktree add "$OTHER_WT" -b "dev/wt-inuse" "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1

# Now try to attach a second worktree to the same existing branch (from_main=false)
# This triggers the "already checked out" error path
setup_worktree "dev/wt-inuse" false
_rc=$?

assert_eq "$_rc" "1" "branch_in_use: setup fails"
assert_eq "$WORKTREE_LAST_ERROR" "branch_in_use" "branch_in_use: WORKTREE_LAST_ERROR set correctly"

# Clean up both worktrees
git worktree remove "$OTHER_WT" --force 2>/dev/null || rm -rf "$OTHER_WT" 2>/dev/null || true
git worktree prune 2>/dev/null || true
git branch -D "dev/wt-inuse" 2>/dev/null || true

# ============================================================
# TEST 5: setup_worktree — worktree_add_failed error
# ============================================================

echo ""
_tlog "=== Test 5: setup_worktree — worktree_add_failed error ==="

_reset_wt

# Try to create a worktree on a nonexistent existing branch
setup_worktree "dev/wt-nonexistent" false
_rc=$?

assert_eq "$_rc" "1" "add_failed: setup fails for nonexistent branch"
assert_eq "$WORKTREE_LAST_ERROR" "worktree_add_failed" "add_failed: WORKTREE_LAST_ERROR set correctly"

# ============================================================
# TEST 6: setup_worktree — WORKTREE_DELETE_STALE_BRANCH
# ============================================================

echo ""
_tlog "=== Test 6: setup_worktree — stale branch deletion ==="

_reset_wt
git branch -D "dev/wt-stale" 2>/dev/null || true

# Create the branch first (simulating a leftover from a failed run)
cd "$PROJECT_DIR"
git branch "dev/wt-stale" "$SKYNET_MAIN_BRANCH" 2>/dev/null

# Verify it exists
git show-ref --verify --quiet "refs/heads/dev/wt-stale" 2>/dev/null \
  && pass "stale-branch: pre-existing branch created" \
  || fail "stale-branch: could not create pre-existing branch"

# Enable stale branch deletion (task-fixer behavior)
WORKTREE_DELETE_STALE_BRANCH="true"

setup_worktree "dev/wt-stale" true
_rc=$?

assert_eq "$_rc" "0" "stale-branch: setup succeeds after deleting stale branch"
[ -d "$WORKTREE_DIR" ] && pass "stale-branch: worktree directory created" \
                       || fail "stale-branch: worktree directory not created"

WT_BRANCH=$(cd "$WORKTREE_DIR" && git rev-parse --abbrev-ref HEAD 2>/dev/null)
assert_eq "$WT_BRANCH" "dev/wt-stale" "stale-branch: worktree on re-created branch"

cleanup_worktree "dev/wt-stale"
unset WORKTREE_DELETE_STALE_BRANCH

# ============================================================
# TEST 7: setup_worktree — stale branch deletion skipped when disabled
# ============================================================

echo ""
_tlog "=== Test 7: setup_worktree — stale branch NOT deleted by default ==="

_reset_wt
git branch -D "dev/wt-nostale" 2>/dev/null || true

# Create the branch first — without WORKTREE_DELETE_STALE_BRANCH, setup
# should fail because the branch already exists (git worktree add -b fails)
cd "$PROJECT_DIR"
git branch "dev/wt-nostale" "$SKYNET_MAIN_BRANCH" 2>/dev/null

# WORKTREE_DELETE_STALE_BRANCH is unset (defaults to false)
setup_worktree "dev/wt-nostale" true
_rc=$?

assert_eq "$_rc" "1" "no-stale-delete: setup fails when branch exists"
assert_eq "$WORKTREE_LAST_ERROR" "worktree_add_failed" "no-stale-delete: error is worktree_add_failed"

git branch -D "dev/wt-nostale" 2>/dev/null || true

# ============================================================
# TEST 8: setup_worktree — install failure (strict mode)
# ============================================================

echo ""
_tlog "=== Test 8: setup_worktree — install failure (strict) ==="

_reset_wt
git branch -D "dev/wt-install-fail" 2>/dev/null || true

export SKYNET_INSTALL_CMD="false"
WORKTREE_INSTALL_STRICT="true"

setup_worktree "dev/wt-install-fail" true
_rc=$?

assert_eq "$_rc" "1" "install-strict: setup fails when install fails"
assert_eq "$WORKTREE_LAST_ERROR" "install_failed" "install-strict: WORKTREE_LAST_ERROR set correctly"

cleanup_worktree "dev/wt-install-fail"
export SKYNET_INSTALL_CMD="true"
unset WORKTREE_INSTALL_STRICT

# ============================================================
# TEST 9: setup_worktree — install failure (non-strict mode)
# ============================================================

echo ""
_tlog "=== Test 9: setup_worktree — install failure (non-strict) ==="

_reset_wt
git branch -D "dev/wt-install-ok" 2>/dev/null || true

export SKYNET_INSTALL_CMD="false"
WORKTREE_INSTALL_STRICT="false"

setup_worktree "dev/wt-install-ok" true
_rc=$?

assert_eq "$_rc" "0" "install-nonstrict: setup succeeds despite install failure"
assert_empty "$WORKTREE_LAST_ERROR" "install-nonstrict: no error set (continues anyway)"
[ -d "$WORKTREE_DIR" ] && pass "install-nonstrict: worktree exists" \
                       || fail "install-nonstrict: worktree should exist"

cleanup_worktree "dev/wt-install-ok"
export SKYNET_INSTALL_CMD="true"
unset WORKTREE_INSTALL_STRICT

# ============================================================
# TEST 10: setup_worktree — install command injection defense
# ============================================================

echo ""
_tlog "=== Test 10: setup_worktree — install command validation ==="

_reset_wt

# Each of these should be rejected by the case guard
_injection_cmds=(
  "pnpm install; rm -rf /"
  "pnpm install | cat /etc/passwd"
  'pnpm install $(whoami)'
  'pnpm install `id`'
  "pnpm install --prefix ../../etc"
)

_injection_pass=0
_injection_total=${#_injection_cmds[@]}

for _cmd in "${_injection_cmds[@]}"; do
  git branch -D "dev/wt-inject" 2>/dev/null || true
  WORKTREE_LAST_ERROR=""
  export SKYNET_INSTALL_CMD="$_cmd"
  setup_worktree "dev/wt-inject" true
  _rc=$?
  if [ "$_rc" -ne 0 ]; then
    _injection_pass=$((_injection_pass + 1))
  fi
  cleanup_worktree "dev/wt-inject" 2>/dev/null || true
done

assert_eq "$_injection_pass" "$_injection_total" "inject-defense: all injection attempts rejected ($_injection_pass/$_injection_total)"

export SKYNET_INSTALL_CMD="true"

# ============================================================
# TEST 11: cleanup_worktree — removes worktree directory
# ============================================================

echo ""
_tlog "=== Test 11: cleanup_worktree — removes worktree ==="

_reset_wt
git branch -D "dev/wt-cleanup" 2>/dev/null || true
cd "$PROJECT_DIR"

git worktree add "$WORKTREE_DIR" -b "dev/wt-cleanup" "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1
[ -d "$WORKTREE_DIR" ] && pass "cleanup: worktree exists before cleanup" \
                       || fail "cleanup: worktree should exist before cleanup"

cleanup_worktree
[ ! -d "$WORKTREE_DIR" ] && pass "cleanup: worktree directory removed" \
                         || fail "cleanup: worktree directory still exists"

# Branch should still exist (no delete_branch arg)
if git show-ref --verify --quiet "refs/heads/dev/wt-cleanup" 2>/dev/null; then
  pass "cleanup: branch preserved (no delete_branch arg)"
else
  fail "cleanup: branch should still exist"
fi

git branch -D "dev/wt-cleanup" 2>/dev/null || true

# ============================================================
# TEST 12: cleanup_worktree — deletes branch when requested
# ============================================================

echo ""
_tlog "=== Test 12: cleanup_worktree — branch deletion ==="

_reset_wt
git branch -D "dev/wt-delete-branch" 2>/dev/null || true
cd "$PROJECT_DIR"

git worktree add "$WORKTREE_DIR" -b "dev/wt-delete-branch" "$SKYNET_MAIN_BRANCH" >/dev/null 2>&1
[ -d "$WORKTREE_DIR" ] && pass "branch-delete: worktree exists" \
                       || fail "branch-delete: worktree should exist"

cleanup_worktree "dev/wt-delete-branch"

[ ! -d "$WORKTREE_DIR" ] && pass "branch-delete: worktree removed" \
                         || fail "branch-delete: worktree still exists"

if git show-ref --verify --quiet "refs/heads/dev/wt-delete-branch" 2>/dev/null; then
  fail "branch-delete: branch should be deleted"
else
  pass "branch-delete: branch deleted"
fi

# ============================================================
# TEST 13: cleanup_worktree — idempotent (no dir to clean)
# ============================================================

echo ""
_tlog "=== Test 13: cleanup_worktree — idempotent when no worktree exists ==="

_reset_wt
cd "$PROJECT_DIR"

# WORKTREE_DIR does not exist
[ ! -d "$WORKTREE_DIR" ] && pass "idempotent: no worktree dir" \
                         || fail "idempotent: dir should not exist"

cleanup_worktree 2>/dev/null
_rc=$?
# Should not fail
assert_eq "$_rc" "0" "idempotent: cleanup_worktree returns 0 with no dir"

# ============================================================
# TEST 14: WORKTREE_LAST_ERROR resets on each setup call
# ============================================================

echo ""
_tlog "=== Test 14: WORKTREE_LAST_ERROR resets between calls ==="

_reset_wt

# Force an error first
setup_worktree "dev/wt-nonexistent-branch" false 2>/dev/null
assert_not_empty "$WORKTREE_LAST_ERROR" "error-reset: error set after failure"

# Now do a successful setup — error should be cleared
git branch -D "dev/wt-reset-test" 2>/dev/null || true
setup_worktree "dev/wt-reset-test" true
_rc=$?

assert_eq "$_rc" "0" "error-reset: second setup succeeds"
assert_empty "$WORKTREE_LAST_ERROR" "error-reset: error cleared on successful setup"

cleanup_worktree "dev/wt-reset-test"

# ============================================================
# TEST 15: setup_worktree — creates SKYNET_WORKTREE_BASE if missing
# ============================================================

echo ""
_tlog "=== Test 15: setup_worktree — creates base directory ==="

_reset_wt
git branch -D "dev/wt-basedir" 2>/dev/null || true

# Remove the worktree base dir
rm -rf "$SKYNET_WORKTREE_BASE"
[ ! -d "$SKYNET_WORKTREE_BASE" ] && pass "basedir: base dir removed" \
                                 || fail "basedir: could not remove base dir"

setup_worktree "dev/wt-basedir" true
_rc=$?

assert_eq "$_rc" "0" "basedir: setup succeeds"
[ -d "$SKYNET_WORKTREE_BASE" ] && pass "basedir: base dir created by setup" \
                               || fail "basedir: base dir should exist"

cleanup_worktree "dev/wt-basedir"

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
