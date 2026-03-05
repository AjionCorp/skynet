#!/usr/bin/env bash
# tests/unit/adaptive-batch.test.sh — Unit tests for _adaptive.sh batch sizing
# and goal weighting behavior.
#
# Covers:
#   - Empty, single, and large batch reweighting
#   - Boost magnitude changes mid-batch
#   - Multi-keyword overlap scoring (title+tag)
#   - Goal vs lagging-criteria keyword interaction
#   - Idempotent reweighting (re-running produces same result)
#   - Partial keyword matches and non-matches in mixed batches
#
# Usage: bash tests/unit/adaptive-batch.test.sh

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

# ── Setup: create isolated environment ──────────────────────────────

TMPDIR_ROOT=$(mktemp -d)
trap 'rm -rf "$TMPDIR_ROOT"' EXIT

export SKYNET_PROJECT_DIR="$TMPDIR_ROOT"
export SKYNET_DEV_DIR="$TMPDIR_ROOT/.dev"
export SKYNET_PROJECT_NAME="test-adaptive-batch"
export SKYNET_LOCK_PREFIX="/tmp/skynet-test-ab-$$"
export SKYNET_STALE_MINUTES=45
export SKYNET_MAX_WORKERS=2
export SKYNET_MAIN_BRANCH="main"
export SKYNET_ADAPTIVE_BOOST=5

mkdir -p "$SKYNET_DEV_DIR"

# Source _db.sh for database helpers (needed by reweight)
source "$REPO_ROOT/scripts/_db.sh"

# Source _adaptive.sh under test
source "$REPO_ROOT/scripts/_adaptive.sh"

# Stub _resolve_active_mission
MOCK_MISSION_FILE=""
_resolve_active_mission() { echo "$MOCK_MISSION_FILE"; }

# Initialize the database
db_init

# ── Helper: create mission files ────────────────────────────────────

MISSION_MULTI="$TMPDIR_ROOT/mission-multi.md"
cat > "$MISSION_MULTI" <<'EOF'
# Mission: Multi-Goal Dashboard

## Goals
- Implement burndown chart visualization
- Add pipeline monitoring metrics
- Create worker efficiency tracking

## Success Criteria
- [x] Dashboard loads without errors
- [ ] Burndown chart shows task completion over time
- [ ] Pipeline metrics display throughput data
- [ ] Worker health monitoring active

## Timeline
Week 1-2
EOF

MISSION_NARROW="$TMPDIR_ROOT/mission-narrow.md"
cat > "$MISSION_NARROW" <<'EOF'
# Mission: Narrow Focus

## Goals
- Improve database performance

## Success Criteria
- [ ] Database queries complete under 100ms

## Timeline
Week 1
EOF

# ══════════════════════════════════════════════════════════════════════
# TEST 1: Empty batch — no pending tasks
# ══════════════════════════════════════════════════════════════════════

echo ""
echo "=== Test 1: Empty batch — no pending tasks ==="

sqlite3 "$DB_PATH" "DELETE FROM tasks;"

# Should succeed without error on an empty table
_adaptive_reweight_pending "$MISSION_MULTI"
rc=$?
assert_eq "$rc" "0" "empty-batch: reweight succeeds with no pending tasks"

count=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM tasks;")
assert_eq "$count" "0" "empty-batch: table still empty after reweight"

# ══════════════════════════════════════════════════════════════════════
# TEST 2: Single task batch
# ══════════════════════════════════════════════════════════════════════

echo ""
echo "=== Test 2: Single task batch ==="

sqlite3 "$DB_PATH" "DELETE FROM tasks;"
_db_no_out "INSERT INTO tasks (title, tag, status, priority) VALUES ('Add burndown chart', 'FEAT', 'pending', 50);"

_adaptive_reweight_pending "$MISSION_MULTI"

offset=$(sqlite3 "$DB_PATH" "SELECT adaptive_offset FROM tasks WHERE title='Add burndown chart';")
assert_eq "$offset" "-5" "single-batch: single matching task gets boosted"

# ══════════════════════════════════════════════════════════════════════
# TEST 3: Large batch — 20 tasks with mixed matches
# ══════════════════════════════════════════════════════════════════════

echo ""
echo "=== Test 3: Large batch — 20 tasks with mixed matches ==="

sqlite3 "$DB_PATH" "DELETE FROM tasks;"

# 10 matching tasks (contain keywords from mission goals/criteria)
_db_no_out "INSERT INTO tasks (title, tag, status, priority) VALUES ('Add burndown chart widget', 'FEAT', 'pending', 50);"
_db_no_out "INSERT INTO tasks (title, tag, status, priority) VALUES ('Fix pipeline metrics', 'FIX', 'pending', 50);"
_db_no_out "INSERT INTO tasks (title, tag, status, priority) VALUES ('Worker efficiency report', 'FEAT', 'pending', 50);"
_db_no_out "INSERT INTO tasks (title, tag, status, priority) VALUES ('Pipeline monitoring alerts', 'FEAT', 'pending', 50);"
_db_no_out "INSERT INTO tasks (title, tag, status, priority) VALUES ('Throughput data display', 'FEAT', 'pending', 50);"
_db_no_out "INSERT INTO tasks (title, tag, status, priority) VALUES ('Tracking dashboard panel', 'FEAT', 'pending', 50);"
_db_no_out "INSERT INTO tasks (title, tag, status, priority) VALUES ('Health monitoring widget', 'FEAT', 'pending', 50);"
_db_no_out "INSERT INTO tasks (title, tag, status, priority) VALUES ('Chart visualization update', 'FEAT', 'pending', 50);"
_db_no_out "INSERT INTO tasks (title, tag, status, priority) VALUES ('Worker health check', 'FEAT', 'pending', 50);"
_db_no_out "INSERT INTO tasks (title, tag, status, priority) VALUES ('Pipeline completion view', 'FEAT', 'pending', 50);"

# 10 non-matching tasks (no keyword overlap with mission)
_db_no_out "INSERT INTO tasks (title, tag, status, priority) VALUES ('Update README file', 'DOCS', 'pending', 50);"
_db_no_out "INSERT INTO tasks (title, tag, status, priority) VALUES ('Fix typo in header', 'FIX', 'pending', 50);"
_db_no_out "INSERT INTO tasks (title, tag, status, priority) VALUES ('Refactor auth module', 'REFACTOR', 'pending', 50);"
_db_no_out "INSERT INTO tasks (title, tag, status, priority) VALUES ('Add login page', 'FEAT', 'pending', 50);"
_db_no_out "INSERT INTO tasks (title, tag, status, priority) VALUES ('Fix CORS issue', 'FIX', 'pending', 50);"
_db_no_out "INSERT INTO tasks (title, tag, status, priority) VALUES ('Lint config update', 'CHORE', 'pending', 50);"
_db_no_out "INSERT INTO tasks (title, tag, status, priority) VALUES ('Bump dependencies', 'CHORE', 'pending', 50);"
_db_no_out "INSERT INTO tasks (title, tag, status, priority) VALUES ('Add unit test', 'TEST', 'pending', 50);"
_db_no_out "INSERT INTO tasks (title, tag, status, priority) VALUES ('Fix eslint rules', 'CHORE', 'pending', 50);"
_db_no_out "INSERT INTO tasks (title, tag, status, priority) VALUES ('Rename variables', 'REFACTOR', 'pending', 50);"

_adaptive_reweight_pending "$MISSION_MULTI"

boosted_count=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM tasks WHERE adaptive_offset != 0 AND status='pending';")
unboosted_count=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM tasks WHERE adaptive_offset = 0 AND status='pending';")
total_count=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM tasks WHERE status='pending';")

assert_eq "$total_count" "20" "large-batch: all 20 tasks present"
# Verify a reasonable number got boosted (at least some matched, some didn't)
if [ "$boosted_count" -gt 0 ] && [ "$unboosted_count" -gt 0 ]; then
  pass "large-batch: mix of boosted ($boosted_count) and unboosted ($unboosted_count) tasks"
else
  fail "large-batch: expected mix of boosted and unboosted (boosted=$boosted_count, unboosted=$unboosted_count)"
fi

# Verify order clause puts boosted tasks first
clause=$(_adaptive_order_clause)
first_title=$(sqlite3 "$DB_PATH" "SELECT title FROM tasks WHERE status='pending' ORDER BY $clause LIMIT 1;")
first_offset=$(sqlite3 "$DB_PATH" "SELECT adaptive_offset FROM tasks WHERE status='pending' ORDER BY $clause LIMIT 1;")
assert_eq "$first_offset" "-5" "large-batch: first task in order is boosted"

# ══════════════════════════════════════════════════════════════════════
# TEST 4: Idempotent reweighting — running twice produces same result
# ══════════════════════════════════════════════════════════════════════

echo ""
echo "=== Test 4: Idempotent reweighting ==="

# Capture offsets after first run (from Test 3)
offsets_before=$(sqlite3 "$DB_PATH" "SELECT id, adaptive_offset FROM tasks ORDER BY id;" | tr '\n' ',')

# Run reweight again with same mission
_adaptive_reweight_pending "$MISSION_MULTI"

offsets_after=$(sqlite3 "$DB_PATH" "SELECT id, adaptive_offset FROM tasks ORDER BY id;" | tr '\n' ',')
assert_eq "$offsets_after" "$offsets_before" "idempotent: second reweight produces identical offsets"

# ══════════════════════════════════════════════════════════════════════
# TEST 5: Boost magnitude change — SKYNET_ADAPTIVE_BOOST=10
# ══════════════════════════════════════════════════════════════════════

echo ""
echo "=== Test 5: Boost magnitude change ==="

sqlite3 "$DB_PATH" "DELETE FROM tasks;"
_db_no_out "INSERT INTO tasks (title, tag, status, priority) VALUES ('Add burndown chart', 'FEAT', 'pending', 50);"
_db_no_out "INSERT INTO tasks (title, tag, status, priority) VALUES ('Update README', 'DOCS', 'pending', 50);"

SKYNET_ADAPTIVE_BOOST=10
_adaptive_reweight_pending "$MISSION_MULTI"

offset_burn=$(sqlite3 "$DB_PATH" "SELECT adaptive_offset FROM tasks WHERE title='Add burndown chart';")
offset_docs=$(sqlite3 "$DB_PATH" "SELECT adaptive_offset FROM tasks WHERE title='Update README';")
assert_eq "$offset_burn" "-10" "boost-magnitude: matching task gets -10 with SKYNET_ADAPTIVE_BOOST=10"
assert_eq "$offset_docs" "0" "boost-magnitude: non-matching task stays 0"

# Change boost to 3 and re-run
SKYNET_ADAPTIVE_BOOST=3
_adaptive_reweight_pending "$MISSION_MULTI"

offset_burn2=$(sqlite3 "$DB_PATH" "SELECT adaptive_offset FROM tasks WHERE title='Add burndown chart';")
assert_eq "$offset_burn2" "-3" "boost-magnitude: offset updates to -3 after boost change"

SKYNET_ADAPTIVE_BOOST=5  # restore

# ══════════════════════════════════════════════════════════════════════
# TEST 6: Goal keywords vs lagging criteria keywords
# ══════════════════════════════════════════════════════════════════════

echo ""
echo "=== Test 6: Goal keywords vs lagging criteria keywords ==="

# The mission has "database" in Goals and "database" in unchecked criteria
# Tasks matching ONLY goal keywords should still get boosted
# (because _adaptive_all_lagging_keywords merges both)
sqlite3 "$DB_PATH" "DELETE FROM tasks;"
_db_no_out "INSERT INTO tasks (title, tag, status, priority) VALUES ('Improve database indexing', 'FEAT', 'pending', 50);"
_db_no_out "INSERT INTO tasks (title, tag, status, priority) VALUES ('Add new API endpoint', 'FEAT', 'pending', 50);"

_adaptive_reweight_pending "$MISSION_NARROW"

offset_db=$(sqlite3 "$DB_PATH" "SELECT adaptive_offset FROM tasks WHERE title='Improve database indexing';")
offset_api=$(sqlite3 "$DB_PATH" "SELECT adaptive_offset FROM tasks WHERE title='Add new API endpoint';")
assert_eq "$offset_db" "-5" "goal-vs-criteria: task matching 'database' from both sections gets boosted"
assert_eq "$offset_api" "0" "goal-vs-criteria: unrelated task stays unboosted"

# Verify keywords are deduplicated between Goals and Success Criteria
keywords=$(_adaptive_all_lagging_keywords "$MISSION_NARROW")
db_count=$(echo "$keywords" | grep -c "^database$" || true)
assert_eq "$db_count" "1" "goal-vs-criteria: 'database' appears once in merged keywords"

# ══════════════════════════════════════════════════════════════════════
# TEST 7: Tag-based matching contributes to boost
# ══════════════════════════════════════════════════════════════════════

echo ""
echo "=== Test 7: Tag contributes to keyword matching ==="

sqlite3 "$DB_PATH" "DELETE FROM tasks;"

# Create a mission where "performance" is a goal keyword
MISSION_PERF="$TMPDIR_ROOT/mission-perf.md"
cat > "$MISSION_PERF" <<'PERFEOF'
# Mission: Performance

## Goals
- Improve system performance under load

## Success Criteria
- [ ] Response times under 200ms
EOF
PERFEOF

# Title has no keyword overlap with mission, but tag "PERFORMANCE" matches
_db_no_out "INSERT INTO tasks (title, tag, status, priority) VALUES ('Execute stress scenario', 'PERFORMANCE', 'pending', 50);"
# Same title, different short tag — no overlap
_db_no_out "INSERT INTO tasks (title, tag, status, priority) VALUES ('Execute stress scenario', 'FEAT', 'pending', 50);"

_adaptive_reweight_pending "$MISSION_PERF"

offset_perf_tag=$(sqlite3 "$DB_PATH" "SELECT adaptive_offset FROM tasks WHERE tag='PERFORMANCE';")
offset_feat_tag=$(sqlite3 "$DB_PATH" "SELECT adaptive_offset FROM tasks WHERE tag='FEAT' AND title='Execute stress scenario';")
assert_eq "$offset_perf_tag" "-5" "tag-match: task with PERFORMANCE tag gets boosted"
assert_eq "$offset_feat_tag" "0" "tag-match: task with short FEAT tag (no title overlap) stays unboosted"

# ══════════════════════════════════════════════════════════════════════
# TEST 8: Switching missions resets and reapplies correctly
# ══════════════════════════════════════════════════════════════════════

echo ""
echo "=== Test 8: Mission switch resets and reapplies ==="

sqlite3 "$DB_PATH" "DELETE FROM tasks;"
_db_no_out "INSERT INTO tasks (title, tag, status, priority) VALUES ('Add burndown chart', 'FEAT', 'pending', 50);"
_db_no_out "INSERT INTO tasks (title, tag, status, priority) VALUES ('Improve database perf', 'FEAT', 'pending', 50);"

# Apply multi-goal mission — burndown matches, database doesn't
_adaptive_reweight_pending "$MISSION_MULTI"
off_burn=$(sqlite3 "$DB_PATH" "SELECT adaptive_offset FROM tasks WHERE title='Add burndown chart';")
off_db=$(sqlite3 "$DB_PATH" "SELECT adaptive_offset FROM tasks WHERE title='Improve database perf';")
assert_eq "$off_burn" "-5" "mission-switch: burndown boosted under multi-goal mission"
assert_eq "$off_db" "0" "mission-switch: database task unboosted under multi-goal mission"

# Switch to narrow mission — database matches, burndown doesn't
_adaptive_reweight_pending "$MISSION_NARROW"
off_burn2=$(sqlite3 "$DB_PATH" "SELECT adaptive_offset FROM tasks WHERE title='Add burndown chart';")
off_db2=$(sqlite3 "$DB_PATH" "SELECT adaptive_offset FROM tasks WHERE title='Improve database perf';")
assert_eq "$off_burn2" "0" "mission-switch: burndown reset after switching to narrow mission"
assert_eq "$off_db2" "-5" "mission-switch: database boosted under narrow mission"

# ══════════════════════════════════════════════════════════════════════
# TEST 9: Tasks with multiple keyword overlaps get same boost as single
# ══════════════════════════════════════════════════════════════════════

echo ""
echo "=== Test 9: Multiple keyword overlaps — flat boost ==="

sqlite3 "$DB_PATH" "DELETE FROM tasks;"

# This task matches many keywords: burndown, chart, pipeline, monitoring, metrics
_db_no_out "INSERT INTO tasks (title, tag, status, priority) VALUES ('Burndown chart pipeline monitoring metrics', 'FEAT', 'pending', 50);"
# This task matches one keyword: burndown
_db_no_out "INSERT INTO tasks (title, tag, status, priority) VALUES ('Burndown display', 'FEAT', 'pending', 50);"

_adaptive_reweight_pending "$MISSION_MULTI"

off_many=$(sqlite3 "$DB_PATH" "SELECT adaptive_offset FROM tasks WHERE title='Burndown chart pipeline monitoring metrics';")
off_one=$(sqlite3 "$DB_PATH" "SELECT adaptive_offset FROM tasks WHERE title='Burndown display';")
assert_eq "$off_many" "-5" "multi-keyword: task with many keyword matches gets standard boost"
assert_eq "$off_one" "-5" "multi-keyword: task with single keyword match gets same boost"
assert_eq "$off_many" "$off_one" "multi-keyword: boost is flat (not proportional to keyword count)"

# ══════════════════════════════════════════════════════════════════════
# TEST 10: All-checked mission still provides goal keywords
# ══════════════════════════════════════════════════════════════════════

echo ""
echo "=== Test 10: All-checked criteria — goal keywords still active ==="

MISSION_ALL_DONE="$TMPDIR_ROOT/mission-all-done.md"
cat > "$MISSION_ALL_DONE" <<'EOF'
# Mission: Completed

## Goals
- Improve database performance

## Success Criteria
- [x] All queries optimized
- [x] Indexes added
EOF

sqlite3 "$DB_PATH" "DELETE FROM tasks;"
_db_no_out "INSERT INTO tasks (title, tag, status, priority) VALUES ('Database tuning', 'FEAT', 'pending', 50);"
_db_no_out "INSERT INTO tasks (title, tag, status, priority) VALUES ('Fix CSS issue', 'FIX', 'pending', 50);"

_adaptive_reweight_pending "$MISSION_ALL_DONE"

# Goal keywords remain even when all criteria are checked
off_db=$(sqlite3 "$DB_PATH" "SELECT adaptive_offset FROM tasks WHERE title='Database tuning';")
off_css=$(sqlite3 "$DB_PATH" "SELECT adaptive_offset FROM tasks WHERE title='Fix CSS issue';")
assert_eq "$off_db" "-5" "all-checked: goal keywords still boost matching tasks"
assert_eq "$off_css" "0" "all-checked: non-matching tasks stay unboosted"

# ══════════════════════════════════════════════════════════════════════
# TEST 11: Effective priority ordering across varied base priorities
# ══════════════════════════════════════════════════════════════════════

echo ""
echo "=== Test 11: Effective priority ordering in batch ==="

sqlite3 "$DB_PATH" "DELETE FROM tasks;"

# Various base priorities — after reweight, boosted tasks should interleave correctly
_db_no_out "INSERT INTO tasks (title, tag, status, priority) VALUES ('Low pri burndown chart', 'FEAT', 'pending', 10);"
_db_no_out "INSERT INTO tasks (title, tag, status, priority) VALUES ('Med pri unrelated', 'DOCS', 'pending', 30);"
_db_no_out "INSERT INTO tasks (title, tag, status, priority) VALUES ('High pri pipeline fix', 'FIX', 'pending', 40);"
_db_no_out "INSERT INTO tasks (title, tag, status, priority) VALUES ('Highest pri docs', 'DOCS', 'pending', 50);"

_adaptive_reweight_pending "$MISSION_MULTI"

clause=$(_adaptive_order_clause)
# Effective priorities: burndown=10-5=5, unrelated=30, pipeline=40-5=35, docs=50
ordered=$(sqlite3 "$DB_PATH" "SELECT title FROM tasks WHERE status='pending' ORDER BY $clause;" | tr '\n' '|')
assert_eq "$ordered" "Low pri burndown chart|Med pri unrelated|High pri pipeline fix|Highest pri docs|" \
  "effective-priority: tasks ordered by (priority + adaptive_offset) ASC"

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
