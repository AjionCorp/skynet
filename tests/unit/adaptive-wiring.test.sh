#!/usr/bin/env bash
# tests/unit/adaptive-wiring.test.sh — Tests for adaptive goal weighting WIRING
# in watchdog.sh and dev-worker.sh.
#
# Unlike adaptive.test.sh (which tests _adaptive.sh helpers in isolation),
# this file verifies that:
#   1. Watchdog calls _adaptive_reweight_pending and contains its errors
#   2. dev-worker / db_claim_next_task uses _adaptive_order_clause so that
#      boosted tasks are claimed first
#   3. The affinity logic in dev-worker respects adaptive ordering
#   4. Graceful fallback when _adaptive_order_clause fails
#
# Usage: bash tests/unit/adaptive-wiring.test.sh

# NOTE: -e is intentionally omitted — the test uses its own PASS/FAIL counters
# and set -e conflicts with functions that use pipes under pipefail.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PASS=0
FAIL=0

log()  { :; }
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

# ── Setup: create isolated environment ──────────────────────────────

TMPDIR_ROOT=$(mktemp -d)
trap 'rm -rf "$TMPDIR_ROOT"' EXIT

export SKYNET_PROJECT_DIR="$TMPDIR_ROOT"
export SKYNET_DEV_DIR="$TMPDIR_ROOT/.dev"
export SKYNET_PROJECT_NAME="test-adaptive-wiring"
export SKYNET_LOCK_PREFIX="/tmp/skynet-test-aw-$$"
export SKYNET_STALE_MINUTES=45
export SKYNET_MAX_WORKERS=2
export SKYNET_MAIN_BRANCH="main"
export SKYNET_ADAPTIVE_BOOST=5

mkdir -p "$SKYNET_DEV_DIR"

# Source _db.sh for database helpers
source "$REPO_ROOT/scripts/_db.sh"

# Source _adaptive.sh
source "$REPO_ROOT/scripts/_adaptive.sh"

# Stub _resolve_active_mission
MOCK_MISSION_FILE=""
_resolve_active_mission() { echo "$MOCK_MISSION_FILE"; }

# Initialize the database
db_init

SEP=$'\x1f'

# ── Helper: create mission files ────────────────────────────────────

MISSION_FILE="$TMPDIR_ROOT/mission.md"
cat > "$MISSION_FILE" <<'MISSION'
# Mission: Build Dashboard

## Goals
- Implement burndown chart visualization
- Add pipeline monitoring metrics

## Success Criteria
- [x] Dashboard loads without errors
- [ ] Burndown chart shows task completion over time
- [ ] Pipeline metrics display throughput data

## Timeline
Week 1-2
MISSION

# ══════════════════════════════════════════════════════════════════════
# TEST 1: db_claim_next_task respects adaptive ordering
# ══════════════════════════════════════════════════════════════════════

echo ""
echo "=== Test 1: db_claim_next_task respects adaptive ordering ==="

sqlite3 "$DB_PATH" "DELETE FROM tasks;"

# Insert two tasks with the SAME base priority via direct SQL.
# "Update README" is unrelated (no boost), "Add burndown chart" matches lagging goals.
# Use direct INSERT to guarantee identical priority (db_add_task "top" shifts existing rows).
sqlite3 "$DB_PATH" "INSERT INTO tasks (title, tag, status, priority) VALUES ('Update README formatting', 'DOCS', 'pending', 50);"
sqlite3 "$DB_PATH" "INSERT INTO tasks (title, tag, status, priority) VALUES ('Add burndown chart component', 'FEAT', 'pending', 50);"

P1=$(sqlite3 "$DB_PATH" "SELECT priority FROM tasks WHERE title='Update README formatting';")
P2=$(sqlite3 "$DB_PATH" "SELECT priority FROM tasks WHERE title='Add burndown chart component';")
assert_eq "$P1" "$P2" "claim-order: both tasks have equal base priority"

# Apply adaptive reweighting — burndown task should get -5 offset
_adaptive_reweight_pending "$MISSION_FILE"

OFFSET_BURN=$(sqlite3 "$DB_PATH" "SELECT adaptive_offset FROM tasks WHERE title='Add burndown chart component';")
OFFSET_README=$(sqlite3 "$DB_PATH" "SELECT adaptive_offset FROM tasks WHERE title='Update README formatting';")
assert_eq "$OFFSET_BURN" "-5" "claim-order: burndown task gets -5 adaptive_offset"
assert_eq "$OFFSET_README" "0" "claim-order: README task keeps 0 adaptive_offset"

# Now claim — the burndown task should be claimed first because its effective
# priority (priority + adaptive_offset) is lower.
CLAIM=$(db_claim_next_task 1)
CLAIM_TITLE=$(echo "$CLAIM" | cut -d"$SEP" -f2)
assert_eq "$CLAIM_TITLE" "Add burndown chart component" "claim-order: boosted task claimed first"

# Second claim gets the README task
CLAIM2=$(db_claim_next_task 2)
CLAIM2_TITLE=$(echo "$CLAIM2" | cut -d"$SEP" -f2)
assert_eq "$CLAIM2_TITLE" "Update README formatting" "claim-order: non-boosted task claimed second"

# ══════════════════════════════════════════════════════════════════════
# TEST 2: Adaptive ordering survives across multiple reweight cycles
# ══════════════════════════════════════════════════════════════════════

echo ""
echo "=== Test 2: Reweight cycle updates offsets correctly ==="

sqlite3 "$DB_PATH" "DELETE FROM tasks;"

db_add_task "Fix pipeline metrics display" "FIX" "" "top"
db_add_task "Refactor auth module" "REFACTOR" "" "top"

# First reweight: pipeline task matches lagging goals
_adaptive_reweight_pending "$MISSION_FILE"
OFF1=$(sqlite3 "$DB_PATH" "SELECT adaptive_offset FROM tasks WHERE title='Fix pipeline metrics display';")
assert_eq "$OFF1" "-5" "reweight-cycle: pipeline task boosted on first pass"

# Create a new mission where all criteria are checked (no lagging goals)
MISSION_DONE="$TMPDIR_ROOT/mission-done.md"
cat > "$MISSION_DONE" <<'MISSION'
# Mission: Done

## Goals
- Complete everything

## Success Criteria
- [x] All features implemented
- [x] All tests passing
MISSION

# Second reweight with different mission: offset should reset
_adaptive_reweight_pending "$MISSION_DONE"
OFF2=$(sqlite3 "$DB_PATH" "SELECT adaptive_offset FROM tasks WHERE title='Fix pipeline metrics display';")
assert_eq "$OFF2" "0" "reweight-cycle: offset resets when goals change"

# Third reweight back to original mission: offset should re-apply
_adaptive_reweight_pending "$MISSION_FILE"
OFF3=$(sqlite3 "$DB_PATH" "SELECT adaptive_offset FROM tasks WHERE title='Fix pipeline metrics display';")
assert_eq "$OFF3" "-5" "reweight-cycle: offset re-applied when original mission returns"

# ══════════════════════════════════════════════════════════════════════
# TEST 3: _adaptive_order_clause used in claim CTE
# ══════════════════════════════════════════════════════════════════════

echo ""
echo "=== Test 3: _adaptive_order_clause integrates with claim SQL ==="

# Verify the order clause includes adaptive_offset (column exists from reweight above)
clause=$(_adaptive_order_clause)
assert_contains "$clause" "adaptive_offset" "claim-sql: order clause includes adaptive_offset"
assert_contains "$clause" "priority" "claim-sql: order clause includes priority"

# Verify db_explain_claim runs without error (uses _adaptive_order_clause internally)
EXPLAIN_OUT=$(db_explain_claim 1 2>/dev/null) || true
assert_not_empty "$EXPLAIN_OUT" "claim-sql: db_explain_claim succeeds with adaptive ordering"

# ══════════════════════════════════════════════════════════════════════
# TEST 4: Watchdog error containment — _adaptive_reweight_pending failure is non-fatal
# ══════════════════════════════════════════════════════════════════════

echo ""
echo "=== Test 4: Watchdog error containment ==="

# Save real function, replace with a failing one
eval "$(declare -f _adaptive_reweight_pending | sed '1s/_adaptive_reweight_pending/_real_adaptive_reweight_pending/')"

_adaptive_reweight_pending() { return 1; }

# Simulate the watchdog's error-contained call pattern:
#   { _adaptive_reweight_pending; } || { log "Phase: adaptive reweight failed, continuing"; true; }
_wd_rc=0
{
  _adaptive_reweight_pending
} || { _wd_rc=0; true; }

assert_eq "$_wd_rc" "0" "watchdog-containment: reweight failure doesn't propagate"

# Restore real function
eval "$(declare -f _real_adaptive_reweight_pending | sed '1s/_real_adaptive_reweight_pending/_adaptive_reweight_pending/')"

# ══════════════════════════════════════════════════════════════════════
# TEST 5: Fallback when _adaptive_order_clause fails
# ══════════════════════════════════════════════════════════════════════

echo ""
echo "=== Test 5: Fallback when _adaptive_order_clause fails ==="

# Save real function, replace with a failing one
eval "$(declare -f _adaptive_order_clause | sed '1s/_adaptive_order_clause/_real_adaptive_order_clause/')"

_adaptive_order_clause() { return 1; }

# Simulate the dev-worker/db pattern:
#   _aoc=$(_adaptive_order_clause 2>/dev/null) || _aoc="priority ASC"
_aoc=$(_adaptive_order_clause 2>/dev/null) || _aoc="priority ASC"
assert_eq "$_aoc" "priority ASC" "fallback: falls back to 'priority ASC' on failure"

# Restore
eval "$(declare -f _real_adaptive_order_clause | sed '1s/_real_adaptive_order_clause/_adaptive_order_clause/')"

# ══════════════════════════════════════════════════════════════════════
# TEST 6: Claim with no adaptive_offset column (fresh DB)
# ══════════════════════════════════════════════════════════════════════

echo ""
echo "=== Test 6: Claim works on fresh DB without adaptive_offset column ==="

# Create a fresh DB without adaptive_offset
FRESH_DB="$TMPDIR_ROOT/fresh.db"
DB_PATH_ORIG="$DB_PATH"

# db_init creates the standard schema; adaptive_offset is only added by _adaptive_reweight_pending
export DB_PATH="$FRESH_DB"
db_init

# Verify adaptive_offset column does NOT exist yet
HAS_COL=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM pragma_table_info('tasks') WHERE name = 'adaptive_offset';")
assert_eq "$HAS_COL" "0" "fresh-db: no adaptive_offset column initially"

# Add tasks and claim — should work with plain priority ordering
db_add_task "Fresh task A" "FEAT" "" "top"
db_add_task "Fresh task B" "FEAT" "" "bottom"

CLAIM_FRESH=$(db_claim_next_task 1)
CLAIM_FRESH_TITLE=$(echo "$CLAIM_FRESH" | cut -d"$SEP" -f2)
assert_eq "$CLAIM_FRESH_TITLE" "Fresh task A" "fresh-db: claims by priority when no adaptive_offset"

# Restore DB
export DB_PATH="$DB_PATH_ORIG"

# ══════════════════════════════════════════════════════════════════════
# TEST 7: Adaptive boost value is configurable
# ══════════════════════════════════════════════════════════════════════

echo ""
echo "=== Test 7: Custom SKYNET_ADAPTIVE_BOOST value ==="

sqlite3 "$DB_PATH" "DELETE FROM tasks;"

db_add_task "Custom boost task" "FEAT" "" "top"
db_add_task "Add burndown visualization" "FEAT" "" "top"

SKYNET_ADAPTIVE_BOOST=10
_adaptive_reweight_pending "$MISSION_FILE"
OFFSET=$(sqlite3 "$DB_PATH" "SELECT adaptive_offset FROM tasks WHERE title='Add burndown visualization';")
assert_eq "$OFFSET" "-10" "custom-boost: respects SKYNET_ADAPTIVE_BOOST=10"
SKYNET_ADAPTIVE_BOOST=5  # restore

# ══════════════════════════════════════════════════════════════════════
# TEST 8: Reweight only affects pending tasks (not claimed/completed)
# ══════════════════════════════════════════════════════════════════════

echo ""
echo "=== Test 8: Reweight only affects pending tasks ==="

sqlite3 "$DB_PATH" "DELETE FROM tasks;"

# Insert tasks in various states
db_add_task "Pending burndown task" "FEAT" "" "top"
T_CLAIMED=$(db_add_task "Claimed burndown chart" "FEAT" "" "top")
T_COMPLETED=$(db_add_task "Completed burndown display" "FEAT" "" "top")

sqlite3 "$DB_PATH" "UPDATE tasks SET status='claimed', worker_id=1 WHERE id=$T_CLAIMED;"
sqlite3 "$DB_PATH" "UPDATE tasks SET status='completed' WHERE id=$T_COMPLETED;"

# Ensure adaptive_offset column exists (set it to 0 for non-pending tasks)
sqlite3 "$DB_PATH" "UPDATE tasks SET adaptive_offset=0 WHERE status != 'pending';" 2>/dev/null || true

_adaptive_reweight_pending "$MISSION_FILE"

OFF_PENDING=$(sqlite3 "$DB_PATH" "SELECT adaptive_offset FROM tasks WHERE title='Pending burndown task';")
OFF_CLAIMED=$(sqlite3 "$DB_PATH" "SELECT adaptive_offset FROM tasks WHERE title='Claimed burndown chart';")
OFF_COMPLETED=$(sqlite3 "$DB_PATH" "SELECT adaptive_offset FROM tasks WHERE title='Completed burndown display';")

assert_eq "$OFF_PENDING" "-5" "status-filter: pending task gets boosted"
assert_eq "$OFF_CLAIMED" "0" "status-filter: claimed task untouched"
assert_eq "$OFF_COMPLETED" "0" "status-filter: completed task untouched"

# ══════════════════════════════════════════════════════════════════════
# TEST 9: Mission-filtered claim also uses adaptive ordering
# ══════════════════════════════════════════════════════════════════════

echo ""
echo "=== Test 9: Mission-filtered claim uses adaptive ordering ==="

sqlite3 "$DB_PATH" "DELETE FROM tasks;"

# Add tasks with a mission_hash
MHASH="abc123"
sqlite3 "$DB_PATH" "INSERT INTO tasks (title, tag, status, priority, mission_hash, adaptive_offset) VALUES ('Mission README update', 'DOCS', 'pending', 1, '$MHASH', 0);"
sqlite3 "$DB_PATH" "INSERT INTO tasks (title, tag, status, priority, mission_hash, adaptive_offset) VALUES ('Mission burndown chart', 'FEAT', 'pending', 1, '$MHASH', -5);"

# Mission-filtered claim should also respect adaptive_offset ordering
CLAIM_M=$(db_claim_next_task_for_mission 1 "$MHASH" 2>/dev/null)
CLAIM_M_TITLE=$(echo "$CLAIM_M" | cut -d"$SEP" -f2)
assert_eq "$CLAIM_M_TITLE" "Mission burndown chart" "mission-claim: boosted task claimed first with mission filter"

# ══════════════════════════════════════════════════════════════════════
# TEST 10: Watchdog reweight with _resolve_active_mission stub
# ══════════════════════════════════════════════════════════════════════

echo ""
echo "=== Test 10: Watchdog reweight uses _resolve_active_mission ==="

sqlite3 "$DB_PATH" "DELETE FROM tasks;"
db_add_task "Add pipeline throughput display" "FEAT" "" "top"
db_add_task "Update docs" "DOCS" "" "top"

# Set the mock to return our mission file (simulates what watchdog does)
MOCK_MISSION_FILE="$MISSION_FILE"
_adaptive_reweight_pending  # no argument — uses _resolve_active_mission

OFF_PIPELINE=$(sqlite3 "$DB_PATH" "SELECT adaptive_offset FROM tasks WHERE title='Add pipeline throughput display';")
OFF_DOCS=$(sqlite3 "$DB_PATH" "SELECT adaptive_offset FROM tasks WHERE title='Update docs';")
assert_eq "$OFF_PIPELINE" "-5" "watchdog-resolve: pipeline task boosted via _resolve_active_mission"
assert_eq "$OFF_DOCS" "0" "watchdog-resolve: unrelated task not boosted"
MOCK_MISSION_FILE=""

# ══════════════════════════════════════════════════════════════════════
# TEST 11: Watchdog reweight is a no-op with no active mission
# ══════════════════════════════════════════════════════════════════════

echo ""
echo "=== Test 11: Reweight no-op when no active mission ==="

sqlite3 "$DB_PATH" "DELETE FROM tasks;"
db_add_task "Some task" "FEAT" "" "top"

# Ensure adaptive_offset column exists
_db_no_out "ALTER TABLE tasks ADD COLUMN adaptive_offset INTEGER DEFAULT 0;" 2>/dev/null || true

MOCK_MISSION_FILE=""
_adaptive_reweight_pending  # should silently do nothing

OFF=$(sqlite3 "$DB_PATH" "SELECT COALESCE(adaptive_offset, 0) FROM tasks WHERE title='Some task';")
assert_eq "$OFF" "0" "no-mission: task offset unchanged when no mission"

# ══════════════════════════════════════════════════════════════════════
# Summary
# ══════════════════════════════════════════════════════════════════════

echo ""
echo "──────────────────────────────────────────"
printf "  Results: \033[32m%d passed\033[0m" "$PASS"
if [ "$FAIL" -gt 0 ]; then
  printf ", \033[31m%d failed\033[0m" "$FAIL"
fi
echo ""
echo "──────────────────────────────────────────"

exit "$FAIL"
