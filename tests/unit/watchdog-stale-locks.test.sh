#!/usr/bin/env bash
# tests/unit/watchdog-stale-locks.test.sh — Unit tests for watchdog stale-lock recovery rules
#
# Verifies that live task-fixer locks are not killed just because they exceed
# SKYNET_STALE_MINUTES when they are still within the fixer agent timeout.
#
# Usage: bash tests/unit/watchdog-stale-locks.test.sh

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); printf "  \033[32m✓\033[0m %s\n" "$*"; }
fail() { FAIL=$((FAIL + 1)); printf "  \033[31m✗\033[0m %s\n" "$*"; }

assert_dir_exists() {
  local dir="$1" msg="$2"
  if [ -d "$dir" ]; then
    pass "$msg"
  else
    fail "$msg (missing '$dir')"
  fi
}

assert_contains() {
  local haystack="$1" needle="$2" msg="$3"
  if echo "$haystack" | grep -qF "$needle"; then
    pass "$msg"
  else
    fail "$msg (expected to contain '$needle')"
  fi
}

TMPDIR_ROOT=$(mktemp -d)
trap 'rm -rf "$TMPDIR_ROOT"' EXIT

source "$REPO_ROOT/scripts/_compat.sh"

export DEV_DIR="$TMPDIR_ROOT/.dev"
export SKYNET_LOCK_PREFIX="$TMPDIR_ROOT/skynet-test"
export SKYNET_MAX_WORKERS=1
export SKYNET_MAX_FIXERS=1
export SKYNET_STALE_MINUTES=30
export SKYNET_AGENT_TIMEOUT_MINUTES=45

mkdir -p "$DEV_DIR"

LOG_CAPTURE="$TMPDIR_ROOT/watchdog.log"
: > "$LOG_CAPTURE"
log() { echo "$*" >> "$LOG_CAPTURE"; }
emit_event() { :; }

recovered=0
_cr_stale_pids=0
_cr_orphaned_tasks=0
_cr_cleaned_worktrees=0
_active_mission_slug=""

eval "$(sed -n '/^_cr_phase1_stale_locks()/,/^}$/p' "$REPO_ROOT/scripts/watchdog.sh")"

echo ""
printf "  %s\n" "=== Test 1: task-fixer lock gets timeout grace ==="

LOCK_DIR="${SKYNET_LOCK_PREFIX}-task-fixer.lock"
mkdir -p "$LOCK_DIR"
echo "$$" > "$LOCK_DIR/pid"
touch -d '40 minutes ago' "$LOCK_DIR"

_cr_phase1_stale_locks
OUTPUT=$(cat "$LOG_CAPTURE")

assert_dir_exists "$LOCK_DIR" "fixer grace: live lock preserved within agent timeout"
assert_contains "$OUTPUT" "still within agent timeout" "fixer grace: watchdog logs timeout-based exemption"

echo ""
printf "  %s\n" "watchdog-stale-locks.test.sh completed: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
