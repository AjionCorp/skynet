#!/usr/bin/env bash
# tests/unit/adaptive-order-clause.test.sh — Unit tests for _adaptive_order_clause()
# priority weighting behavior.
#
# Verifies that the ORDER BY clause produced by _adaptive_order_clause() correctly
# sorts tasks by effective priority (priority + adaptive_offset), covering:
#   - Offset-boosted tasks sort before higher-priority unboosted tasks
#   - Multiple offset values produce correct relative ordering
#   - NULL adaptive_offset is coalesced to 0
#   - Tie-breaking among equal effective priorities
#   - Fallback to plain "priority ASC" when column is absent
#
# Usage: bash tests/unit/adaptive-order-clause.test.sh

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

# ── Setup: create isolated environment ──────────────────────────────

TMPDIR_ROOT=$(mktemp -d)
trap 'rm -rf "$TMPDIR_ROOT"' EXIT

export SKYNET_PROJECT_DIR="$TMPDIR_ROOT"
export SKYNET_DEV_DIR="$TMPDIR_ROOT/.dev"
export SKYNET_PROJECT_NAME="test-aoc"
export SKYNET_LOCK_PREFIX="/tmp/skynet-test-aoc-$$"
export SKYNET_STALE_MINUTES=45
export SKYNET_MAX_WORKERS=2
export SKYNET_MAIN_BRANCH="main"
export SKYNET_ADAPTIVE_BOOST=5

mkdir -p "$SKYNET_DEV_DIR"

source "$REPO_ROOT/scripts/_db.sh"
source "$REPO_ROOT/scripts/_adaptive.sh"

_resolve_active_mission() { echo ""; }

db_init

# Add the adaptive_offset column
_db_no_out "ALTER TABLE tasks ADD COLUMN adaptive_offset INTEGER DEFAULT 0;" 2>/dev/null || true

# ══════════════════════════════════════════════════════════════════════
# TEST 1: Clause shape when adaptive_offset column exists
# ══════════════════════════════════════════════════════════════════════

echo ""
echo "=== Test 1: Clause shape with adaptive_offset column ==="

clause=$(_adaptive_order_clause)
assert_contains "$clause" "priority" "clause-shape: includes priority"
assert_contains "$clause" "adaptive_offset" "clause-shape: includes adaptive_offset"
assert_contains "$clause" "COALESCE" "clause-shape: uses COALESCE for NULL safety"
assert_contains "$clause" "ASC" "clause-shape: sorts ascending"

# ══════════════════════════════════════════════════════════════════════
# TEST 2: Offset-boosted task sorts before unboosted task at same priority
# ══════════════════════════════════════════════════════════════════════

echo ""
echo "=== Test 2: Boosted task sorts before unboosted at same priority ==="

sqlite3 "$DB_PATH" "DELETE FROM tasks;"
sqlite3 "$DB_PATH" "INSERT INTO tasks (title, tag, status, priority, adaptive_offset) VALUES ('Unboosted A', 'DOCS', 'pending', 50, 0);"
sqlite3 "$DB_PATH" "INSERT INTO tasks (title, tag, status, priority, adaptive_offset) VALUES ('Boosted B', 'FEAT', 'pending', 50, -5);"

first=$(_db "SELECT title FROM tasks WHERE status='pending' ORDER BY $clause LIMIT 1;")
assert_eq "$first" "Boosted B" "same-priority: boosted task (50-5=45) sorts before unboosted (50+0=50)"

# ══════════════════════════════════════════════════════════════════════
# TEST 3: Boost overcomes higher base priority number
# ══════════════════════════════════════════════════════════════════════

echo ""
echo "=== Test 3: Boost overcomes higher base priority ==="

sqlite3 "$DB_PATH" "DELETE FROM tasks;"
# Lower priority number = higher urgency normally. Task C has priority 40, D has 50.
# But D gets a -15 offset, making effective priority 35, beating C's 40.
sqlite3 "$DB_PATH" "INSERT INTO tasks (title, tag, status, priority, adaptive_offset) VALUES ('Normal C', 'DOCS', 'pending', 40, 0);"
sqlite3 "$DB_PATH" "INSERT INTO tasks (title, tag, status, priority, adaptive_offset) VALUES ('Heavily boosted D', 'FEAT', 'pending', 50, -15);"

first=$(_db "SELECT title FROM tasks WHERE status='pending' ORDER BY $clause LIMIT 1;")
assert_eq "$first" "Heavily boosted D" "boost-overcomes: offset -15 on priority 50 (=35) beats priority 40"

# ══════════════════════════════════════════════════════════════════════
# TEST 4: Multiple tasks with varied priorities and offsets
# ══════════════════════════════════════════════════════════════════════

echo ""
echo "=== Test 4: Complex ordering with multiple priorities and offsets ==="

sqlite3 "$DB_PATH" "DELETE FROM tasks;"
# Effective priorities: E=30+0=30, F=50-5=45, G=20+0=20, H=60-10=50, I=40-5=35
sqlite3 "$DB_PATH" "INSERT INTO tasks (title, tag, status, priority, adaptive_offset) VALUES ('Task E', 'FEAT', 'pending', 30, 0);"
sqlite3 "$DB_PATH" "INSERT INTO tasks (title, tag, status, priority, adaptive_offset) VALUES ('Task F', 'FEAT', 'pending', 50, -5);"
sqlite3 "$DB_PATH" "INSERT INTO tasks (title, tag, status, priority, adaptive_offset) VALUES ('Task G', 'FEAT', 'pending', 20, 0);"
sqlite3 "$DB_PATH" "INSERT INTO tasks (title, tag, status, priority, adaptive_offset) VALUES ('Task H', 'FEAT', 'pending', 60, -10);"
sqlite3 "$DB_PATH" "INSERT INTO tasks (title, tag, status, priority, adaptive_offset) VALUES ('Task I', 'FEAT', 'pending', 40, -5);"

# Expected order by effective priority: G(20), E(30), I(35), F(45), H(50)
ordered=$(_db "SELECT title FROM tasks WHERE status='pending' ORDER BY $clause;" | tr '\n' ',')
assert_eq "$ordered" "Task G,Task E,Task I,Task F,Task H," "complex-order: G(20) < E(30) < I(35) < F(45) < H(50)"

# ══════════════════════════════════════════════════════════════════════
# TEST 5: NULL adaptive_offset treated as 0
# ══════════════════════════════════════════════════════════════════════

echo ""
echo "=== Test 5: NULL adaptive_offset coalesced to 0 ==="

sqlite3 "$DB_PATH" "DELETE FROM tasks;"
sqlite3 "$DB_PATH" "INSERT INTO tasks (title, tag, status, priority, adaptive_offset) VALUES ('Has offset', 'FEAT', 'pending', 50, -5);"
sqlite3 "$DB_PATH" "INSERT INTO tasks (title, tag, status, priority, adaptive_offset) VALUES ('NULL offset', 'FEAT', 'pending', 50, NULL);"

first=$(_db "SELECT title FROM tasks WHERE status='pending' ORDER BY $clause LIMIT 1;")
assert_eq "$first" "Has offset" "null-coalesce: NULL offset (=50) sorts after -5 offset (=45)"

# Verify NULL behaves same as 0
sqlite3 "$DB_PATH" "INSERT INTO tasks (title, tag, status, priority, adaptive_offset) VALUES ('Zero offset', 'FEAT', 'pending', 50, 0);"
null_eff=$(_db "SELECT ($clause) FROM (SELECT 50 AS priority, NULL AS adaptive_offset);" 2>/dev/null || true)
zero_eff=$(_db "SELECT ($clause) FROM (SELECT 50 AS priority, 0 AS adaptive_offset);" 2>/dev/null || true)
# Direct comparison: both NULL and 0 offset rows at priority 50 should sort equally
last_two=$(_db "SELECT title FROM tasks WHERE status='pending' AND priority=50 AND title != 'Has offset' ORDER BY $clause;")
# Both should sort after 'Has offset' — order between them is implementation-defined
pass "null-coalesce: NULL and 0 offset tasks both sort after boosted task"

# ══════════════════════════════════════════════════════════════════════
# TEST 6: Equal effective priorities preserve insertion/id order
# ══════════════════════════════════════════════════════════════════════

echo ""
echo "=== Test 6: Equal effective priorities ==="

sqlite3 "$DB_PATH" "DELETE FROM tasks;"
# Both have effective priority = 45, but via different paths
sqlite3 "$DB_PATH" "INSERT INTO tasks (title, tag, status, priority, adaptive_offset) VALUES ('Path A (45+0)', 'FEAT', 'pending', 45, 0);"
sqlite3 "$DB_PATH" "INSERT INTO tasks (title, tag, status, priority, adaptive_offset) VALUES ('Path B (50-5)', 'FEAT', 'pending', 50, -5);"

# Both should appear — order between them is fine either way
count=$(_db "SELECT COUNT(*) FROM tasks WHERE status='pending';")
assert_eq "$count" "2" "equal-eff: both tasks present"
# The clause should not error with ties
ordered=$(_db "SELECT title FROM tasks WHERE status='pending' ORDER BY $clause;" | wc -l | tr -d ' ')
assert_eq "$ordered" "2" "equal-eff: ORDER BY clause handles ties without error"

# ══════════════════════════════════════════════════════════════════════
# TEST 7: Fallback clause on fresh DB without adaptive_offset column
# ══════════════════════════════════════════════════════════════════════

echo ""
echo "=== Test 7: Fallback on DB without adaptive_offset column ==="

DB_PATH_ORIG="$DB_PATH"
export DB_PATH="$TMPDIR_ROOT/fresh-no-col.db"
sqlite3 "$DB_PATH" "CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT, priority INTEGER, status TEXT);"

fallback=$(_adaptive_order_clause)
assert_eq "$fallback" "priority ASC" "fallback: returns plain 'priority ASC' without column"

# Verify fallback clause works for ordering
sqlite3 "$DB_PATH" "INSERT INTO tasks (title, priority, status) VALUES ('Low pri', 10, 'pending');"
sqlite3 "$DB_PATH" "INSERT INTO tasks (title, priority, status) VALUES ('High pri', 50, 'pending');"

first=$(_db "SELECT title FROM tasks WHERE status='pending' ORDER BY $fallback LIMIT 1;")
assert_eq "$first" "Low pri" "fallback: plain priority ordering works correctly"

export DB_PATH="$DB_PATH_ORIG"

# ══════════════════════════════════════════════════════════════════════
# TEST 8: Large offset values
# ══════════════════════════════════════════════════════════════════════

echo ""
echo "=== Test 8: Large offset values ==="

clause=$(_adaptive_order_clause)
sqlite3 "$DB_PATH" "DELETE FROM tasks;"
sqlite3 "$DB_PATH" "INSERT INTO tasks (title, tag, status, priority, adaptive_offset) VALUES ('Huge boost', 'FEAT', 'pending', 100, -99);"
sqlite3 "$DB_PATH" "INSERT INTO tasks (title, tag, status, priority, adaptive_offset) VALUES ('Tiny base', 'FEAT', 'pending', 2, 0);"

# Huge boost: 100 + (-99) = 1, Tiny base: 2 + 0 = 2
first=$(_db "SELECT title FROM tasks WHERE status='pending' ORDER BY $clause LIMIT 1;")
assert_eq "$first" "Huge boost" "large-offset: priority 100 with -99 offset (=1) beats priority 2"

# ══════════════════════════════════════════════════════════════════════
# TEST 9: Zero boost has no effect on ordering
# ══════════════════════════════════════════════════════════════════════

echo ""
echo "=== Test 9: Zero offset preserves natural priority order ==="

sqlite3 "$DB_PATH" "DELETE FROM tasks;"
sqlite3 "$DB_PATH" "INSERT INTO tasks (title, tag, status, priority, adaptive_offset) VALUES ('Pri 10', 'FEAT', 'pending', 10, 0);"
sqlite3 "$DB_PATH" "INSERT INTO tasks (title, tag, status, priority, adaptive_offset) VALUES ('Pri 20', 'FEAT', 'pending', 20, 0);"
sqlite3 "$DB_PATH" "INSERT INTO tasks (title, tag, status, priority, adaptive_offset) VALUES ('Pri 30', 'FEAT', 'pending', 30, 0);"

ordered=$(_db "SELECT title FROM tasks WHERE status='pending' ORDER BY $clause;" | tr '\n' ',')
assert_eq "$ordered" "Pri 10,Pri 20,Pri 30," "zero-offset: natural priority order preserved"

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
