#!/usr/bin/env bash
# tests/unit/notify.test.sh — Unit tests for scripts/_notify.sh
#
# Tests the notification helpers: _redact_for_log (sensitive value redaction),
# _notify_all (multi-channel dispatch with IFS isolation), tg (backward compat),
# and tg_throttled (throttled notification with flag file).
#
# Usage: bash tests/unit/notify.test.sh

# NOTE: -e is intentionally omitted — the test uses its own PASS/FAIL counters
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PASS=0
FAIL=0

log()  { printf "  %s\n" "$*"; }
pass() { PASS=$((PASS + 1)); printf "  \033[32m✓\033[0m %s\n" "$*"; }
fail() { FAIL=$((FAIL + 1)); printf "  \033[31m✗\033[0m %s\n" "$*"; }

assert_eq() {
  local actual="$1" expected="$2" msg="$3"
  if [ "$actual" = "$expected" ]; then
    pass "$msg"
  else
    fail "$msg (expected '$expected', got '$actual')"
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

assert_file_contains() {
  local file="$1" needle="$2" msg="$3"
  if grep -qF "$needle" "$file" 2>/dev/null; then
    pass "$msg"
  else
    fail "$msg (file did not contain '$needle')"
  fi
}

assert_file_empty() {
  local file="$1" msg="$2"
  if [ ! -s "$file" ]; then
    pass "$msg"
  else
    fail "$msg (file was not empty: '$(cat "$file")')"
  fi
}

# ── Setup: create isolated environment ──────────────────────────────

TMPDIR_ROOT=$(mktemp -d)
cleanup() {
  rm -rf "$TMPDIR_ROOT"
}
trap cleanup EXIT

# File-based call log — works across subshells (which _notify_all uses)
CALL_LOG="$TMPDIR_ROOT/notify-calls.log"
: > "$CALL_LOG"

# Minimal config stubs needed by _notify.sh
export SKYNET_SCRIPTS_DIR="$REPO_ROOT/scripts"
export SKYNET_NOTIFY_CHANNELS="mock_a"

# Source the module under test (loads real channel plugins too)
source "$REPO_ROOT/scripts/_notify.sh"

# Define mock channel functions AFTER sourcing — these write to a file
# so state is visible from the subshell that _notify_all uses.
notify_mock_a() {
  echo "mock_a:$1" >> "$CALL_LOG"
}
notify_mock_b() {
  echo "mock_b:$1" >> "$CALL_LOG"
}
notify_mock_fail() {
  echo "mock_fail:$1" >> "$CALL_LOG"
  return 1
}

# Export mock functions so subshells can see them
export -f notify_mock_a notify_mock_b notify_mock_fail
export CALL_LOG

# ── Test 1: _redact_for_log — short string (≤8 chars) ──────────────

echo ""
log "=== _redact_for_log: short string ==="

result=$(_redact_for_log "abc")
assert_eq "$result" "***" "_redact_for_log: 3-char string is fully redacted"

result=$(_redact_for_log "12345678")
assert_eq "$result" "***" "_redact_for_log: exactly 8-char string is fully redacted"

# ── Test 2: _redact_for_log — long string (>8 chars) ───────────────

echo ""
log "=== _redact_for_log: long string ==="

result=$(_redact_for_log "sk_live_abc123xyz789")
assert_eq "$result" "sk_l...z789" "_redact_for_log: shows first 4 + last 4 of long string"

result=$(_redact_for_log "123456789")
assert_eq "$result" "1234...6789" "_redact_for_log: 9-char string shows first 4 + last 4"

# ── Test 3: _redact_for_log — empty string ──────────────────────────

echo ""
log "=== _redact_for_log: empty string ==="

result=$(_redact_for_log "")
assert_eq "$result" "***" "_redact_for_log: empty string is fully redacted"

# ── Test 4: _redact_for_log — special characters ────────────────────

echo ""
log "=== _redact_for_log: special characters ==="

result=$(_redact_for_log "https://hooks.slack.com/services/T00/B00/xxxx")
assert_eq "$result" "http...xxxx" "_redact_for_log: URL is redacted showing first 4 + last 4"

# ── Test 5: _notify_all — dispatches to single channel ──────────────

echo ""
log "=== _notify_all: single channel dispatch ==="

: > "$CALL_LOG"
export SKYNET_NOTIFY_CHANNELS="mock_a"
_notify_all "hello world"

assert_file_contains "$CALL_LOG" "mock_a:hello world" "_notify_all: dispatches to mock_a"

# ── Test 6: _notify_all — dispatches to multiple channels ───────────

echo ""
log "=== _notify_all: multiple channels ==="

: > "$CALL_LOG"
export SKYNET_NOTIFY_CHANNELS="mock_a,mock_b"
_notify_all "multi-msg"

assert_file_contains "$CALL_LOG" "mock_a:multi-msg" "_notify_all: dispatches to mock_a"
assert_file_contains "$CALL_LOG" "mock_b:multi-msg" "_notify_all: dispatches to mock_b"

# ── Test 7: _notify_all — skips empty channel names ─────────────────

echo ""
log "=== _notify_all: skips empty channel names ==="

: > "$CALL_LOG"
export SKYNET_NOTIFY_CHANNELS="mock_a,,mock_b"
_notify_all "skip-empty"

assert_file_contains "$CALL_LOG" "mock_a:skip-empty" "_notify_all: mock_a called despite empty middle entry"
assert_file_contains "$CALL_LOG" "mock_b:skip-empty" "_notify_all: mock_b called despite empty middle entry"

# ── Test 8: _notify_all — handles spaces around channel names ───────

echo ""
log "=== _notify_all: trims whitespace around channel names ==="

: > "$CALL_LOG"
export SKYNET_NOTIFY_CHANNELS=" mock_a , mock_b "
_notify_all "trimmed"

assert_file_contains "$CALL_LOG" "mock_a:trimmed" "_notify_all: mock_a called with whitespace-trimmed name"
assert_file_contains "$CALL_LOG" "mock_b:trimmed" "_notify_all: mock_b called with whitespace-trimmed name"

# ── Test 9: _notify_all — silences channel failures ──────────────────

echo ""
log "=== _notify_all: silences channel failures ==="

: > "$CALL_LOG"
export SKYNET_NOTIFY_CHANNELS="mock_fail,mock_a"
_notify_all "after-fail"

assert_file_contains "$CALL_LOG" "mock_fail:after-fail" "_notify_all: failing channel was called"
assert_file_contains "$CALL_LOG" "mock_a:after-fail" "_notify_all: mock_a called after mock_fail failure"

# ── Test 10: _notify_all — skips undefined channel functions ─────────

echo ""
log "=== _notify_all: skips undefined channel functions ==="

: > "$CALL_LOG"
export SKYNET_NOTIFY_CHANNELS="nonexistent_channel,mock_a"
_notify_all "skip-undef"

assert_file_contains "$CALL_LOG" "mock_a:skip-undef" "_notify_all: mock_a called after skipping undefined channel"
# Verify nonexistent_channel was NOT called
if grep -qF "nonexistent_channel" "$CALL_LOG" 2>/dev/null; then
  fail "_notify_all: should not have called nonexistent_channel"
else
  pass "_notify_all: correctly skipped undefined channel function"
fi

# ── Test 11: _notify_all — IFS isolation (no global corruption) ─────

echo ""
log "=== _notify_all: IFS isolation ==="

export SKYNET_NOTIFY_CHANNELS="mock_a,mock_b"

# Save current IFS
_saved_ifs="$IFS"
_notify_all "ifs-test"

# Verify IFS was not corrupted by the subshell
if [ "$IFS" = "$_saved_ifs" ]; then
  pass "_notify_all: IFS unchanged after dispatch (subshell isolation works)"
else
  fail "_notify_all: IFS was corrupted (expected '$_saved_ifs', got '$IFS')"
fi

# ── Test 12: _notify_all — empty channel list ───────────────────────

echo ""
log "=== _notify_all: empty channel list ==="

: > "$CALL_LOG"
export SKYNET_NOTIFY_CHANNELS=""
_notify_all "no-channels"

assert_file_empty "$CALL_LOG" "_notify_all: no channels called when list is empty"

# ── Test 13: tg — backward compatibility wrapper ────────────────────

echo ""
log "=== tg: backward compatibility ==="

: > "$CALL_LOG"
export SKYNET_NOTIFY_CHANNELS="mock_a"
tg "compat-message"

assert_file_contains "$CALL_LOG" "mock_a:compat-message" "tg: delegates to _notify_all correctly"

# ── Test 14: tg_throttled — first call sends immediately ────────────

echo ""
log "=== tg_throttled: first call sends immediately ==="

: > "$CALL_LOG"
export SKYNET_NOTIFY_CHANNELS="mock_a"
FLAG_FILE="$TMPDIR_ROOT/throttle/first.flag"

tg_throttled "$FLAG_FILE" 3600 "first-call"

assert_file_contains "$CALL_LOG" "mock_a:first-call" "tg_throttled: first call dispatches message"

# Verify flag file was created with timestamp
if [ -f "$FLAG_FILE" ]; then
  pass "tg_throttled: flag file created"
  flag_content=$(cat "$FLAG_FILE")
  # Verify it looks like a unix timestamp (all digits)
  case "$flag_content" in
    *[!0-9]*)
      fail "tg_throttled: flag file should contain unix timestamp (got '$flag_content')"
      ;;
    *)
      pass "tg_throttled: flag file contains numeric timestamp"
      ;;
  esac
else
  fail "tg_throttled: flag file should exist after first call"
fi

# ── Test 15: tg_throttled — second call within interval is suppressed

echo ""
log "=== tg_throttled: second call within interval is suppressed ==="

: > "$CALL_LOG"
# FLAG_FILE already contains a fresh timestamp from Test 14
tg_throttled "$FLAG_FILE" 3600 "suppressed-call"

assert_file_empty "$CALL_LOG" "tg_throttled: message suppressed within interval"

# ── Test 16: tg_throttled — call after interval expires ─────────────

echo ""
log "=== tg_throttled: call after interval expires ==="

: > "$CALL_LOG"
FLAG_FILE2="$TMPDIR_ROOT/throttle/expired.flag"
mkdir -p "$(dirname "$FLAG_FILE2")"

# Write an old timestamp (1 hour + 10 seconds ago)
old_ts=$(($(date +%s) - 3610))
echo "$old_ts" > "$FLAG_FILE2"

tg_throttled "$FLAG_FILE2" 3600 "expired-call"

assert_file_contains "$CALL_LOG" "mock_a:expired-call" "tg_throttled: dispatches after interval expires"

# Verify flag file was updated with new timestamp
new_ts=$(cat "$FLAG_FILE2")
if [ "$new_ts" -gt "$old_ts" ]; then
  pass "tg_throttled: flag file updated with new timestamp"
else
  fail "tg_throttled: flag file should have newer timestamp (old=$old_ts, new=$new_ts)"
fi

# ── Test 17: tg_throttled — creates parent directory for flag file ──

echo ""
log "=== tg_throttled: creates parent directory for flag file ==="

: > "$CALL_LOG"
DEEP_FLAG="$TMPDIR_ROOT/throttle/deep/nested/dir/flag.txt"

tg_throttled "$DEEP_FLAG" 3600 "deep-dir"

if [ -f "$DEEP_FLAG" ]; then
  pass "tg_throttled: creates nested parent directories for flag file"
else
  fail "tg_throttled: should create parent directories for flag file"
fi
assert_file_contains "$CALL_LOG" "mock_a:deep-dir" "tg_throttled: message dispatched with deep flag path"

# ── Test 18: tg_throttled — zero interval always sends ──────────────

echo ""
log "=== tg_throttled: zero interval always sends ==="

FLAG_FILE3="$TMPDIR_ROOT/throttle/zero.flag"
mkdir -p "$(dirname "$FLAG_FILE3")"
# Write a recent timestamp
echo "$(date +%s)" > "$FLAG_FILE3"

: > "$CALL_LOG"
tg_throttled "$FLAG_FILE3" 0 "zero-interval"

assert_file_contains "$CALL_LOG" "mock_a:zero-interval" "tg_throttled: sends when interval is 0 (diff is never < 0)"

# ── Test 19: tg_throttled — no flag file (first ever call) ──────────

echo ""
log "=== tg_throttled: no flag file (first ever call) ==="

: > "$CALL_LOG"
FRESH_FLAG="$TMPDIR_ROOT/throttle/fresh-new.flag"
# Ensure flag file does NOT exist
rm -f "$FRESH_FLAG"

tg_throttled "$FRESH_FLAG" 3600 "brand-new"

assert_file_contains "$CALL_LOG" "mock_a:brand-new" "tg_throttled: sends on first ever call (no flag file)"
if [ -f "$FRESH_FLAG" ]; then
  pass "tg_throttled: flag file created on first call"
else
  fail "tg_throttled: flag file should be created on first call"
fi

# ── Test 20: _notify_all — message with special characters ──────────

echo ""
log "=== _notify_all: message with special characters ==="

: > "$CALL_LOG"
export SKYNET_NOTIFY_CHANNELS="mock_a"
_notify_all "hello 'world' & <test>"

assert_file_contains "$CALL_LOG" "mock_a:" "_notify_all: dispatches message with special characters"

# ── Summary ──────────────────────────────────────────────────────────

echo ""
TOTAL=$((PASS + FAIL))
log "Results: $PASS/$TOTAL passed, $FAIL failed"
if [ "$FAIL" -eq 0 ]; then
  printf "  \033[32mAll checks passed!\033[0m\n"
else
  printf "  \033[31mSome checks failed!\033[0m\n"
  exit 1
fi
