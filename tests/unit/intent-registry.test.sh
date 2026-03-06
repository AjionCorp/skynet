#!/usr/bin/env bash
# tests/unit/intent-registry.test.sh — Unit tests for intent registry helpers in _config.sh
#
# Tests: _intent_write, _intent_read, _intent_read_full, _intent_list,
#        _intent_clear, _intent_prune
#
# Usage: bash tests/unit/intent-registry.test.sh

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
  if printf '%s' "$haystack" | grep -qF "$needle"; then
    pass "$msg"
  else
    fail "$msg (expected to contain '$needle', got '$haystack')"
  fi
}

assert_not_empty() {
  local actual="$1" msg="$2"
  if [ -n "$actual" ]; then
    pass "$msg"
  else
    fail "$msg (expected non-empty, got empty)"
  fi
}

assert_empty() {
  local actual="$1" msg="$2"
  if [ -z "$actual" ]; then
    pass "$msg"
  else
    fail "$msg (expected empty, got '$actual')"
  fi
}

# ── Setup: create isolated environment ──────────────────────────────

TMPDIR_ROOT=$(mktemp -d)
cleanup() { rm -rf "$TMPDIR_ROOT"; }
trap cleanup EXIT

# Create minimal config for sourcing _config.sh
export SKYNET_DEV_DIR="$TMPDIR_ROOT/dev"
mkdir -p "$SKYNET_DEV_DIR/missions"
cat > "$SKYNET_DEV_DIR/skynet.config.sh" << CONF
export SKYNET_PROJECT_NAME="test-intent"
export SKYNET_PROJECT_DIR="$TMPDIR_ROOT/project"
export SKYNET_DEV_DIR="$SKYNET_DEV_DIR"
CONF
mkdir -p "$TMPDIR_ROOT/project"

# Source _config.sh (suppressing warnings from validators/notify)
cd "$REPO_ROOT"
source scripts/_config.sh 2>/dev/null || true
set +e  # _config.sh enables errexit; disable for test assertions

echo "intent-registry.test.sh — unit tests for intent registry helpers in _config.sh"

# ── _intent_write + _intent_read ─────────────────────────────────

echo ""
log "=== _intent_write + _intent_read ==="

# Test 1: write and read back an intent
_intent_write 1 "claiming"
result=$(_intent_read 1)
assert_eq "$result" "claiming" "_intent_write/_intent_read: round-trip"

# Test 2: overwrite existing intent
_intent_write 1 "building"
result=$(_intent_read 1)
assert_eq "$result" "building" "_intent_write: overwrites previous intent"

# Test 3: read non-existent worker returns empty
result=$(_intent_read 99)
assert_empty "$result" "_intent_read: returns empty for non-existent worker"

# Test 4: creates intents directory if missing
_saved_intents_dir="$SKYNET_INTENTS_DIR"
export SKYNET_INTENTS_DIR="$TMPDIR_ROOT/fresh-intents"
_intent_write 5 "testing"
if [ -d "$SKYNET_INTENTS_DIR" ]; then
  pass "_intent_write: creates intents directory if missing"
else
  fail "_intent_write: creates intents directory if missing"
fi
result=$(_intent_read 5)
assert_eq "$result" "testing" "_intent_write: works with freshly created directory"
export SKYNET_INTENTS_DIR="$_saved_intents_dir"

# Test 5: intent file has correct format (intent|epoch)
_intent_write 2 "merging"
content=$(cat "$SKYNET_INTENTS_DIR/worker-2" 2>/dev/null)
if printf '%s' "$content" | grep -qE '^merging\|[0-9]+$'; then
  pass "_intent_write: file format is intent|epoch"
else
  fail "_intent_write: file format is intent|epoch (got '$content')"
fi

# ── _intent_read_full ────────────────────────────────────────────

echo ""
log "=== _intent_read_full ==="

# Test 6: returns intent with epoch
_intent_write 3 "idle"
result=$(_intent_read_full 3)
if printf '%s' "$result" | grep -qE '^idle\|[0-9]+$'; then
  pass "_intent_read_full: returns intent|epoch format"
else
  fail "_intent_read_full: returns intent|epoch format (got '$result')"
fi

# Test 7: parse intent and epoch separately
IFS='|' read -r intent epoch <<< "$result"
assert_eq "$intent" "idle" "_intent_read_full: parsed intent is correct"
if [ -n "$epoch" ] && [ "$epoch" -gt 0 ] 2>/dev/null; then
  pass "_intent_read_full: parsed epoch is a positive integer"
else
  fail "_intent_read_full: parsed epoch is a positive integer (got '$epoch')"
fi

# Test 8: returns empty for non-existent worker
result=$(_intent_read_full 98)
assert_empty "$result" "_intent_read_full: returns empty for non-existent worker"

# ── _intent_list ─────────────────────────────────────────────────

echo ""
log "=== _intent_list ==="

# Clear all intents first
rm -rf "$SKYNET_INTENTS_DIR"
mkdir -p "$SKYNET_INTENTS_DIR"

# Test 9: empty list when no intents
result=$(_intent_list)
assert_empty "$result" "_intent_list: empty when no intents"

# Test 10: lists single worker intent
_intent_write 1 "claiming"
result=$(_intent_list)
assert_contains "$result" "1|claiming|" "_intent_list: lists single worker intent"

# Test 11: lists multiple worker intents
_intent_write 2 "building"
_intent_write 3 "merging"
result=$(_intent_list)
line_count=$(printf '%s\n' "$result" | wc -l | tr -d ' ')
assert_eq "$line_count" "3" "_intent_list: lists all three workers"
assert_contains "$result" "1|claiming|" "_intent_list: includes worker 1"
assert_contains "$result" "2|building|" "_intent_list: includes worker 2"
assert_contains "$result" "3|merging|" "_intent_list: includes worker 3"

# Test 12: output format is worker_id|intent|epoch
first_line=$(printf '%s\n' "$result" | head -1)
if printf '%s' "$first_line" | grep -qE '^[0-9]+\|[a-z]+\|[0-9]+$'; then
  pass "_intent_list: output format is wid|intent|epoch"
else
  fail "_intent_list: output format is wid|intent|epoch (got '$first_line')"
fi

# Test 13: handles missing intents directory gracefully
_saved_intents_dir="$SKYNET_INTENTS_DIR"
export SKYNET_INTENTS_DIR="$TMPDIR_ROOT/nonexistent-intents"
result=$(_intent_list)
assert_empty "$result" "_intent_list: handles missing directory gracefully"
export SKYNET_INTENTS_DIR="$_saved_intents_dir"

# ── _intent_clear ────────────────────────────────────────────────

echo ""
log "=== _intent_clear ==="

# Test 14: clears existing intent
_intent_write 4 "building"
result=$(_intent_read 4)
assert_eq "$result" "building" "_intent_clear: precondition — intent exists"
_intent_clear 4
result=$(_intent_read 4)
assert_empty "$result" "_intent_clear: clears existing intent"

# Test 15: intent file is actually removed
if [ ! -f "$SKYNET_INTENTS_DIR/worker-4" ]; then
  pass "_intent_clear: file is removed"
else
  fail "_intent_clear: file is removed"
fi

# Test 16: clearing non-existent intent is a no-op
_intent_clear 97
pass "_intent_clear: no-op for non-existent worker (no error)"

# Test 17: cleared intent doesn't appear in list
_intent_write 5 "idle"
_intent_clear 5
result=$(_intent_list)
if printf '%s' "$result" | grep -qF "5|"; then
  fail "_intent_clear: cleared worker should not appear in list"
else
  pass "_intent_clear: cleared worker does not appear in list"
fi

# ── _intent_prune ────────────────────────────────────────────────

echo ""
log "=== _intent_prune ==="

# Clean slate
rm -rf "$SKYNET_INTENTS_DIR"
mkdir -p "$SKYNET_INTENTS_DIR"

# Test 18: does not prune recent intents
_intent_write 1 "building"
_intent_prune 60
result=$(_intent_read 1)
assert_eq "$result" "building" "_intent_prune: does not prune recent intents"

# Test 19: prunes stale intent with dead PID
# Create a manually backdated intent file (epoch 0 = 1970)
printf 'stale|0' > "$SKYNET_INTENTS_DIR/worker-50"
_intent_prune 1
if [ ! -f "$SKYNET_INTENTS_DIR/worker-50" ]; then
  pass "_intent_prune: removes stale intent with no active PID"
else
  fail "_intent_prune: removes stale intent with no active PID"
fi

# Test 20: prunes intent with invalid epoch
printf 'bad|notanumber' > "$SKYNET_INTENTS_DIR/worker-51"
_intent_prune 1
if [ ! -f "$SKYNET_INTENTS_DIR/worker-51" ]; then
  pass "_intent_prune: removes intent with invalid epoch"
else
  fail "_intent_prune: removes intent with invalid epoch"
fi

# Test 21: prunes intent with empty epoch
printf 'empty|' > "$SKYNET_INTENTS_DIR/worker-52"
_intent_prune 1
if [ ! -f "$SKYNET_INTENTS_DIR/worker-52" ]; then
  pass "_intent_prune: removes intent with empty epoch"
else
  fail "_intent_prune: removes intent with empty epoch"
fi

# Test 22: handles missing intents directory gracefully
_saved_intents_dir="$SKYNET_INTENTS_DIR"
export SKYNET_INTENTS_DIR="$TMPDIR_ROOT/nonexistent-prune-dir"
_intent_prune 1
pass "_intent_prune: handles missing directory gracefully (no error)"
export SKYNET_INTENTS_DIR="$_saved_intents_dir"

# Test 23: does not prune stale intent if worker PID is still alive
# Use our own PID as a "still alive" worker
_our_pid=$$
printf "stale|0" > "$SKYNET_INTENTS_DIR/worker-53"
# Create a fake worker lock directory with pid file
mkdir -p "${SKYNET_LOCK_PREFIX}-dev-worker-53.lock" 2>/dev/null || true
echo "$_our_pid" > "${SKYNET_LOCK_PREFIX}-dev-worker-53.lock/pid"
_intent_prune 0
if [ -f "$SKYNET_INTENTS_DIR/worker-53" ]; then
  pass "_intent_prune: keeps stale intent if worker PID is alive"
else
  fail "_intent_prune: keeps stale intent if worker PID is alive"
fi
rm -rf "${SKYNET_LOCK_PREFIX}-dev-worker-53.lock" 2>/dev/null
rm -f "$SKYNET_INTENTS_DIR/worker-53" 2>/dev/null

# Test 24: respects max_age_minutes parameter
# Create intent that is 2 minutes old
_two_min_ago=$(( $(date +%s) - 120 ))
printf "recent|%s" "$_two_min_ago" > "$SKYNET_INTENTS_DIR/worker-54"
# Prune with 5-minute threshold — should NOT be pruned
_intent_prune 5
if [ -f "$SKYNET_INTENTS_DIR/worker-54" ]; then
  pass "_intent_prune: respects max_age_minutes (keeps within threshold)"
else
  fail "_intent_prune: respects max_age_minutes (keeps within threshold)"
fi
# Prune with 1-minute threshold — should be pruned
_intent_prune 1
if [ ! -f "$SKYNET_INTENTS_DIR/worker-54" ]; then
  pass "_intent_prune: respects max_age_minutes (removes beyond threshold)"
else
  fail "_intent_prune: respects max_age_minutes (removes beyond threshold)"
fi

# ── Atomic write safety ──────────────────────────────────────────

echo ""
log "=== Atomic write safety ==="

# Test 25: no leftover .tmp files after write
_intent_write 6 "testing"
tmp_files=$(find "$SKYNET_INTENTS_DIR" -name "*.tmp.*" 2>/dev/null | wc -l | tr -d ' ')
assert_eq "$tmp_files" "0" "_intent_write: no leftover .tmp files"

# Test 26: multiple rapid writes don't corrupt
for i in 1 2 3 4 5; do
  _intent_write 7 "rapid-$i"
done
result=$(_intent_read 7)
assert_eq "$result" "rapid-5" "_intent_write: last write wins after rapid succession"

# ── Edge cases ───────────────────────────────────────────────────

echo ""
log "=== Edge cases ==="

# Test 27: intent with special characters (hyphens, underscores)
_intent_write 8 "pre-merge_check"
result=$(_intent_read 8)
assert_eq "$result" "pre-merge_check" "_intent_read: handles hyphens and underscores"

# Test 28: intent with spaces
_intent_write 9 "waiting for lock"
result=$(_intent_read 9)
assert_eq "$result" "waiting for lock" "_intent_read: handles intent with spaces"

# Test 29: worker ID with large number
_intent_write 100 "building"
result=$(_intent_read 100)
assert_eq "$result" "building" "_intent_read: handles large worker IDs"
_intent_clear 100

# ── Summary ─────────────────────────────────────────────────────────

echo ""
TOTAL=$((PASS + FAIL))
log "Results: $PASS/$TOTAL passed, $FAIL failed"
if [ "$FAIL" -eq 0 ]; then
  printf "  \033[32mAll checks passed!\033[0m\n"
else
  printf "  \033[31mSome checks failed!\033[0m\n"
  exit 1
fi
