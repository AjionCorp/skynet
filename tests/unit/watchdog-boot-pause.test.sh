#!/usr/bin/env bash
# tests/unit/watchdog-boot-pause.test.sh — Unit tests for watchdog boot-to-pause initialization
#
# Verifies:
#   1. First boot creates both pipeline-paused and the boot-to-pause sentinel.
#   2. Later watchdog restarts preserve a resumed pipeline instead of re-pausing it.
#
# Usage: bash tests/unit/watchdog-boot-pause.test.sh

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); printf "  \033[32m✓\033[0m %s\n" "$*"; }
fail() { FAIL=$((FAIL + 1)); printf "  \033[31m✗\033[0m %s\n" "$*"; }

assert_file_exists() {
  local file="$1" msg="$2"
  if [ -f "$file" ]; then
    pass "$msg"
  else
    fail "$msg (missing '$file')"
  fi
}

assert_file_not_exists() {
  local file="$1" msg="$2"
  if [ ! -f "$file" ]; then
    pass "$msg"
  else
    fail "$msg (unexpected '$file')"
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

export DEV_DIR="$TMPDIR_ROOT/.dev"
mkdir -p "$DEV_DIR"

LOG_CAPTURE="$TMPDIR_ROOT/watchdog.log"
: > "$LOG_CAPTURE"
log() { echo "$*" >> "$LOG_CAPTURE"; }

eval "$(sed -n '/^_initialize_boot_pause()/,/^}$/p' "$REPO_ROOT/scripts/watchdog.sh")"

echo ""
printf "  %s\n" "=== Test 1: first boot initializes paused state ==="

_initialize_boot_pause
OUTPUT=$(cat "$LOG_CAPTURE")

assert_file_exists "$DEV_DIR/pipeline-paused" "first boot: pause file created"
assert_file_exists "$DEV_DIR/.boot-to-pause-initialized" "first boot: boot-to-pause sentinel created"
assert_contains "$OUTPUT" "Pipeline initialized in PAUSED state" "first boot: initialization logged"

echo ""
printf "  %s\n" "=== Test 2: restart after resume preserves running state ==="

rm -f "$DEV_DIR/pipeline-paused"
: > "$LOG_CAPTURE"

_initialize_boot_pause
OUTPUT=$(cat "$LOG_CAPTURE")

assert_file_not_exists "$DEV_DIR/pipeline-paused" "restart: pause file not recreated after resume"
assert_contains "$OUTPUT" "preserving current running state" "restart: running state preserved"

echo ""
printf "  %s\n" "watchdog-boot-pause.test.sh completed: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
