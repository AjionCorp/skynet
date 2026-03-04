#!/usr/bin/env bash
# tests/unit/adaptive.test.sh — Unit tests for scripts/_adaptive.sh helpers
#
# Tests keyword extraction, task matching, boost computation, batch reweighting,
# and the ORDER BY clause helper.
#
# Usage: bash tests/unit/adaptive.test.sh

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

assert_not_contains() {
  local haystack="$1" needle="$2" msg="$3"
  if echo "$haystack" | grep -qF "$needle"; then
    fail "$msg (should NOT contain '$needle')"
  else
    pass "$msg"
  fi
}

assert_empty() {
  local val="$1" msg="$2"
  if [ -z "$val" ]; then pass "$msg"
  else fail "$msg (expected empty, got '$val')"; fi
}

assert_not_empty() {
  local val="$1" msg="$2"
  if [ -n "$val" ]; then pass "$msg"
  else fail "$msg (was empty)"; fi
}

assert_rc() {
  local rc="$1" expected="$2" msg="$3"
  if [ "$rc" = "$expected" ]; then pass "$msg"
  else fail "$msg (expected rc=$expected, got rc=$rc)"; fi
}

# ── Setup: create isolated environment ──────────────────────────────

TMPDIR_ROOT=$(mktemp -d)
trap 'rm -rf "$TMPDIR_ROOT"' EXIT

export SKYNET_PROJECT_DIR="$TMPDIR_ROOT"
export SKYNET_DEV_DIR="$TMPDIR_ROOT/.dev"
export SKYNET_PROJECT_NAME="test-adaptive"
export SKYNET_LOCK_PREFIX="/tmp/skynet-test-adaptive-$$"
export SKYNET_STALE_MINUTES=45
export SKYNET_MAX_WORKERS=2
export SKYNET_MAIN_BRANCH="main"
export SKYNET_ADAPTIVE_BOOST=5

mkdir -p "$SKYNET_DEV_DIR"

# Source _db.sh for database helpers (needed by reweight/order_clause)
source "$REPO_ROOT/scripts/_db.sh"

# Source _adaptive.sh under test
source "$REPO_ROOT/scripts/_adaptive.sh"

# Stub _resolve_active_mission (used by _adaptive_reweight_pending and _adaptive_status)
MOCK_MISSION_FILE=""
_resolve_active_mission() {
  echo "$MOCK_MISSION_FILE"
}

# Initialize the database
db_init

# ── Helper: create mission files ────────────────────────────────────

create_mission_file() {
  local file="$1"
  local content="$2"
  echo "$content" > "$file"
}

# ── Test mission file ───────────────────────────────────────────────

MISSION_FULL="$TMPDIR_ROOT/mission-full.md"
create_mission_file "$MISSION_FULL" "# Mission: Build Dashboard

## Goals
- Implement burndown chart visualization
- Add pipeline monitoring metrics
- Create worker efficiency tracking

## Success Criteria
- [x] Dashboard loads without errors
- [ ] Burndown chart shows task completion over time
- [ ] Pipeline metrics display throughput data
- [x] Worker status updates in real-time

## Timeline
Week 1-2: Implementation"

MISSION_ALL_CHECKED="$TMPDIR_ROOT/mission-done.md"
create_mission_file "$MISSION_ALL_CHECKED" "# Mission: Done

## Goals
- Complete everything

## Success Criteria
- [x] All features implemented
- [x] All tests passing"

MISSION_NO_GOALS="$TMPDIR_ROOT/mission-no-goals.md"
create_mission_file "$MISSION_NO_GOALS" "# Mission: Minimal

## Overview
Just a description, no goals section."

MISSION_EMPTY_CRITERIA="$TMPDIR_ROOT/mission-empty-criteria.md"
create_mission_file "$MISSION_EMPTY_CRITERIA" "# Mission: Partial

## Goals
- Build monitoring system

## Success Criteria

## Notes
Nothing here yet."

# ══════════════════════════════════════════════════════════════════════
# Tests
# ══════════════════════════════════════════════════════════════════════

echo ""
echo "=== _adaptive_goal_keywords ==="

result=$(_adaptive_goal_keywords "$MISSION_FULL")
assert_contains "$result" "burndown" "_adaptive_goal_keywords: extracts 'burndown'"
assert_contains "$result" "chart" "_adaptive_goal_keywords: extracts 'chart'"
assert_contains "$result" "pipeline" "_adaptive_goal_keywords: extracts 'pipeline'"
assert_contains "$result" "monitoring" "_adaptive_goal_keywords: extracts 'monitoring'"
assert_contains "$result" "metrics" "_adaptive_goal_keywords: extracts 'metrics'"
assert_contains "$result" "worker" "_adaptive_goal_keywords: extracts 'worker'"
assert_contains "$result" "efficiency" "_adaptive_goal_keywords: extracts 'efficiency'"
assert_contains "$result" "tracking" "_adaptive_goal_keywords: extracts 'tracking'"
assert_not_contains "$result" "add" "_adaptive_goal_keywords: excludes short word 'add'"

result_empty=$(_adaptive_goal_keywords "$MISSION_NO_GOALS")
assert_empty "$result_empty" "_adaptive_goal_keywords: returns empty for file without Goals section"

result_missing=$(_adaptive_goal_keywords "/nonexistent/file.md")
assert_empty "$result_missing" "_adaptive_goal_keywords: returns empty for missing file"

result_no_arg=$(_adaptive_goal_keywords "")
assert_empty "$result_no_arg" "_adaptive_goal_keywords: returns empty for empty argument"

result_empty_criteria=$(_adaptive_goal_keywords "$MISSION_EMPTY_CRITERIA")
assert_contains "$result_empty_criteria" "monitoring" "_adaptive_goal_keywords: extracts from Goals even when criteria empty"
assert_contains "$result_empty_criteria" "build" "_adaptive_goal_keywords: extracts 'build' (>=4 chars)"
assert_contains "$result_empty_criteria" "system" "_adaptive_goal_keywords: extracts 'system'"

echo ""
echo "=== _adaptive_lagging_keywords ==="

result=$(_adaptive_lagging_keywords "$MISSION_FULL")
assert_contains "$result" "burndown" "_adaptive_lagging_keywords: extracts 'burndown' from unchecked"
assert_contains "$result" "chart" "_adaptive_lagging_keywords: extracts 'chart' from unchecked"
assert_contains "$result" "pipeline" "_adaptive_lagging_keywords: extracts 'pipeline' from unchecked"
assert_contains "$result" "metrics" "_adaptive_lagging_keywords: extracts 'metrics' from unchecked"
assert_contains "$result" "throughput" "_adaptive_lagging_keywords: extracts 'throughput' from unchecked"
# Checked items should not appear uniquely (unless same word appears in unchecked)
assert_not_contains "$result" "loads" "_adaptive_lagging_keywords: excludes words from checked items"
assert_not_contains "$result" "real" "_adaptive_lagging_keywords: excludes words from checked items (short)"

result_done=$(_adaptive_lagging_keywords "$MISSION_ALL_CHECKED")
assert_empty "$result_done" "_adaptive_lagging_keywords: returns empty when all criteria checked"

result_no_goals=$(_adaptive_lagging_keywords "$MISSION_NO_GOALS")
assert_empty "$result_no_goals" "_adaptive_lagging_keywords: returns empty for file without criteria"

result_empty_crit=$(_adaptive_lagging_keywords "$MISSION_EMPTY_CRITERIA")
assert_empty "$result_empty_crit" "_adaptive_lagging_keywords: returns empty for empty criteria section"

echo ""
echo "=== _adaptive_all_lagging_keywords ==="

result=$(_adaptive_all_lagging_keywords "$MISSION_FULL")
# Should contain words from both Goals and lagging criteria
assert_contains "$result" "implement" "_adaptive_all_lagging_keywords: contains goal keyword"
assert_contains "$result" "throughput" "_adaptive_all_lagging_keywords: contains lagging criterion keyword"
assert_contains "$result" "burndown" "_adaptive_all_lagging_keywords: contains word from both sections"

# Deduplication: keywords appearing in both sections should appear only once
count=$(echo "$result" | grep -c "^burndown$" || true)
assert_eq "$count" "1" "_adaptive_all_lagging_keywords: deduplicates keywords"

result_done=$(_adaptive_all_lagging_keywords "$MISSION_ALL_CHECKED")
# Should still have goal keywords even though all criteria are checked
assert_not_empty "$result_done" "_adaptive_all_lagging_keywords: returns goal keywords even when criteria done"

echo ""
echo "=== _adaptive_task_matches ==="

keywords=$(_adaptive_all_lagging_keywords "$MISSION_FULL")

_adaptive_task_matches "Add burndown chart component" "FEAT" "$keywords"
rc=$?
assert_rc "$rc" "0" "_adaptive_task_matches: matches 'burndown chart' task"

_adaptive_task_matches "Fix pipeline monitoring dashboard" "FIX" "$keywords"
rc=$?
assert_rc "$rc" "0" "_adaptive_task_matches: matches 'pipeline monitoring' task"

_adaptive_task_matches "Update README formatting" "DOCS" "$keywords"
rc=$?
assert_rc "$rc" "1" "_adaptive_task_matches: no match for unrelated task"

_adaptive_task_matches "Fix typo in header" "FIX" "$keywords"
rc=$?
assert_rc "$rc" "1" "_adaptive_task_matches: no match for short-word-only task"

# Tag-based matching
_adaptive_task_matches "Something about tracking" "FEAT" "$keywords"
rc=$?
assert_rc "$rc" "0" "_adaptive_task_matches: matches via title keyword 'tracking'"

# Empty keywords should not match
_adaptive_task_matches "Add burndown chart" "FEAT" ""
rc=$?
assert_rc "$rc" "1" "_adaptive_task_matches: returns 1 for empty keywords"

# Case insensitivity
_adaptive_task_matches "Add BURNDOWN Chart" "FEAT" "$keywords"
rc=$?
assert_rc "$rc" "0" "_adaptive_task_matches: case-insensitive title matching"

echo ""
echo "=== _adaptive_compute_boost ==="

boost=$(_adaptive_compute_boost "Add burndown chart" "FEAT" "$keywords")
assert_eq "$boost" "5" "_adaptive_compute_boost: returns SKYNET_ADAPTIVE_BOOST for matching task"

boost=$(_adaptive_compute_boost "Update README" "DOCS" "$keywords")
assert_eq "$boost" "0" "_adaptive_compute_boost: returns 0 for non-matching task"

# Custom boost value
SKYNET_ADAPTIVE_BOOST=10
boost=$(_adaptive_compute_boost "Add burndown chart" "FEAT" "$keywords")
assert_eq "$boost" "10" "_adaptive_compute_boost: respects custom SKYNET_ADAPTIVE_BOOST"
SKYNET_ADAPTIVE_BOOST=5  # restore

echo ""
echo "=== _adaptive_reweight_pending ==="

# Insert test tasks
_db_no_out "INSERT INTO tasks (title, tag, status, priority) VALUES ('Add burndown chart', 'FEAT', 'pending', 50);"
_db_no_out "INSERT INTO tasks (title, tag, status, priority) VALUES ('Fix pipeline metrics display', 'FIX', 'pending', 50);"
_db_no_out "INSERT INTO tasks (title, tag, status, priority) VALUES ('Update README formatting', 'DOCS', 'pending', 50);"
_db_no_out "INSERT INTO tasks (title, tag, status, priority) VALUES ('Refactor auth module', 'REFACTOR', 'pending', 50);"
_db_no_out "INSERT INTO tasks (title, tag, status, priority) VALUES ('Done task', 'FEAT', 'completed', 50);"

_adaptive_reweight_pending "$MISSION_FULL"

# Check boosted tasks got adaptive_offset
offset_burndown=$(_db "SELECT adaptive_offset FROM tasks WHERE title = 'Add burndown chart';")
assert_eq "$offset_burndown" "-5" "_adaptive_reweight_pending: burndown task gets -5 offset"

offset_pipeline=$(_db "SELECT adaptive_offset FROM tasks WHERE title = 'Fix pipeline metrics display';")
assert_eq "$offset_pipeline" "-5" "_adaptive_reweight_pending: pipeline task gets -5 offset"

# Non-matching tasks should have 0 offset
offset_readme=$(_db "SELECT adaptive_offset FROM tasks WHERE title = 'Update README formatting';")
assert_eq "$offset_readme" "0" "_adaptive_reweight_pending: README task keeps 0 offset"

offset_auth=$(_db "SELECT adaptive_offset FROM tasks WHERE title = 'Refactor auth module';")
assert_eq "$offset_auth" "0" "_adaptive_reweight_pending: auth task keeps 0 offset"

# Completed tasks should not be touched
offset_done=$(_db "SELECT adaptive_offset FROM tasks WHERE title = 'Done task';")
assert_eq "$offset_done" "0" "_adaptive_reweight_pending: completed task not touched"

# Re-run with all criteria checked — boosted tasks should reset
_adaptive_reweight_pending "$MISSION_ALL_CHECKED"

offset_burndown2=$(_db "SELECT adaptive_offset FROM tasks WHERE title = 'Add burndown chart';")
# All criteria checked, but Goals keywords still match — should still be boosted
# because _adaptive_all_lagging_keywords includes goal section keywords
# Actually mission_all_checked has different goals so burndown won't match
assert_eq "$offset_burndown2" "0" "_adaptive_reweight_pending: resets offset when goals change"

echo ""
echo "=== _adaptive_reweight_pending (edge cases) ==="

# No mission file — should be a no-op
_adaptive_reweight_pending "/nonexistent/mission.md"
offset_after=$(_db "SELECT adaptive_offset FROM tasks WHERE title = 'Add burndown chart';")
assert_eq "$offset_after" "0" "_adaptive_reweight_pending: no-op for missing mission file"

# Empty argument — uses _resolve_active_mission stub
MOCK_MISSION_FILE="$MISSION_FULL"
_adaptive_reweight_pending
offset_via_resolve=$(_db "SELECT adaptive_offset FROM tasks WHERE title = 'Add burndown chart';")
assert_eq "$offset_via_resolve" "-5" "_adaptive_reweight_pending: uses _resolve_active_mission when no arg"
MOCK_MISSION_FILE=""

echo ""
echo "=== _adaptive_order_clause ==="

# After reweight, the adaptive_offset column exists
clause=$(_adaptive_order_clause)
assert_contains "$clause" "adaptive_offset" "_adaptive_order_clause: includes adaptive_offset when column exists"
assert_contains "$clause" "priority" "_adaptive_order_clause: includes priority"
assert_contains "$clause" "ASC" "_adaptive_order_clause: sorts ASC"

# Verify the clause produces correct ordering
# Burndown (priority=50, offset=-5) should sort before README (priority=50, offset=0)
first_task=$(_db "SELECT title FROM tasks WHERE status = 'pending' ORDER BY $clause LIMIT 1;")
assert_eq "$first_task" "Add burndown chart" "_adaptive_order_clause: boosted tasks sort first"

echo ""
echo "=== _adaptive_order_clause (no column) ==="

# Test with a fresh database that has no adaptive_offset column
DB_PATH_ORIG="$DB_PATH"
export DB_PATH="$TMPDIR_ROOT/fresh.db"
sqlite3 "$DB_PATH" "CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT, priority INTEGER, status TEXT);"
clause_no_col=$(_adaptive_order_clause)
assert_eq "$clause_no_col" "priority ASC" "_adaptive_order_clause: falls back to plain priority when no column"
export DB_PATH="$DB_PATH_ORIG"

echo ""
echo "=== Keyword extraction edge cases ==="

# Mission with mixed case
MISSION_CASE="$TMPDIR_ROOT/mission-case.md"
create_mission_file "$MISSION_CASE" "# Mission

## Goals
- Implement DASHBOARD Monitoring
- Add Pipeline ANALYTICS

## Success Criteria
- [ ] Dashboard shows BURNDOWN Charts"

result_case=$(_adaptive_goal_keywords "$MISSION_CASE")
assert_contains "$result_case" "dashboard" "_adaptive_goal_keywords: lowercases uppercase words"
assert_contains "$result_case" "monitoring" "_adaptive_goal_keywords: lowercases mixed case"
assert_contains "$result_case" "analytics" "_adaptive_goal_keywords: lowercases all-caps"

result_lag_case=$(_adaptive_lagging_keywords "$MISSION_CASE")
assert_contains "$result_lag_case" "burndown" "_adaptive_lagging_keywords: lowercases unchecked criteria"
assert_contains "$result_lag_case" "charts" "_adaptive_lagging_keywords: lowercases trailing words"

# Mission with special characters
MISSION_SPECIAL="$TMPDIR_ROOT/mission-special.md"
create_mission_file "$MISSION_SPECIAL" "# Mission

## Goals
- Add auto-scaling (horizontal pod autoscaler)
- Implement rate-limiting & throttling

## Success Criteria
- [ ] Auto-scaling works under load
- [ ] Rate-limiting handles 1000 req/sec"

result_special=$(_adaptive_goal_keywords "$MISSION_SPECIAL")
assert_contains "$result_special" "auto" "_adaptive_goal_keywords: splits hyphenated 'auto-scaling'"
assert_contains "$result_special" "scaling" "_adaptive_goal_keywords: splits hyphenated words"
assert_contains "$result_special" "throttling" "_adaptive_goal_keywords: extracts word after &"
assert_not_contains "$result_special" "1000" "_adaptive_goal_keywords: excludes pure numbers (4+ digits)"

# Words exactly at min length boundary
MISSION_BOUNDARY="$TMPDIR_ROOT/mission-boundary.md"
create_mission_file "$MISSION_BOUNDARY" "# Mission

## Goals
- Add new API for the app data sync tool

## Success Criteria
- [ ] The API data sync tool works"

result_boundary=$(_adaptive_goal_keywords "$MISSION_BOUNDARY")
assert_not_contains "$result_boundary" "add" "_adaptive_goal_keywords: excludes 3-char word 'add'"
assert_not_contains "$result_boundary" "new" "_adaptive_goal_keywords: excludes 3-char word 'new'"
assert_not_contains "$result_boundary" "api" "_adaptive_goal_keywords: excludes 3-char word 'api'"
assert_not_contains "$result_boundary" "for" "_adaptive_goal_keywords: excludes 3-char word 'for'"
assert_not_contains "$result_boundary" "the" "_adaptive_goal_keywords: excludes 3-char word 'the'"
assert_not_contains "$result_boundary" "app" "_adaptive_goal_keywords: excludes 3-char word 'app'"
assert_contains "$result_boundary" "data" "_adaptive_goal_keywords: includes 4-char word 'data'"
assert_contains "$result_boundary" "sync" "_adaptive_goal_keywords: includes 4-char word 'sync'"
assert_contains "$result_boundary" "tool" "_adaptive_goal_keywords: includes 4-char word 'tool'"

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
