#!/usr/bin/env bash
# tests/unit/mission-summary.test.sh — Regression tests for mission_write_completion_summary()
#
# Tests the completion summary writer in scripts/mission-state.sh:
#   - Output file creation and atomic write (tmp+mv)
#   - Metrics table accuracy (completed, failed, fixed, blocked, superseded counts)
#   - Self-correction rate calculation
#   - Average duration computation
#   - Success criteria parsing and display
#   - Task breakdown by category/tag
#   - Edge cases: missing mission file, missing DB, empty DB, no tags
#
# Usage: bash tests/unit/mission-summary.test.sh

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
    fail "$msg (expected to contain '$needle')"
  fi
}

assert_not_contains() {
  local haystack="$1" needle="$2" msg="$3"
  if ! printf '%s' "$haystack" | grep -qF "$needle"; then
    pass "$msg"
  else
    fail "$msg (should NOT contain '$needle')"
  fi
}

assert_file_exists() {
  local path="$1" msg="$2"
  if [ -f "$path" ]; then
    pass "$msg"
  else
    fail "$msg (file not found: $path)"
  fi
}

assert_file_not_exists() {
  local path="$1" msg="$2"
  if [ ! -f "$path" ]; then
    pass "$msg"
  else
    fail "$msg (file unexpectedly exists: $path)"
  fi
}

# ── Setup: create isolated environment ──────────────────────────────

TMPDIR_ROOT=$(mktemp -d)
cleanup() { rm -rf "$TMPDIR_ROOT"; }
trap cleanup EXIT

# Minimal config stubs for _db.sh and _config.sh
export SKYNET_PROJECT_DIR="$TMPDIR_ROOT"
export SKYNET_DEV_DIR="$TMPDIR_ROOT/.dev"
export SKYNET_PROJECT_NAME="test-summary"
export SKYNET_LOCK_PREFIX="/tmp/skynet-test-summary"
export SKYNET_STALE_MINUTES=45
export SKYNET_MAX_WORKERS=4
export SKYNET_MAIN_BRANCH="main"

mkdir -p "$SKYNET_DEV_DIR/missions"

# Provide a stub log() for sourcing
log() { :; }

# Source _db.sh directly (sets DB_PATH, defines _db, _db_sep, db_init)
source "$REPO_ROOT/scripts/_db.sh"

# Stub _generate_trace_id if needed by _db.sh
_generate_trace_id() {
  printf '%s' "test-$$-$(date +%s)"
}

# Initialize DB (creates tasks table)
db_init

# Source mission-state.sh (defines mission_write_completion_summary)
source "$REPO_ROOT/scripts/mission-state.sh"

# Restore log for test output
log()  { printf "  %s\n" "$*"; }

set +e  # Disable errexit for test assertions

echo "mission-summary.test.sh — regression tests for mission completion summary writer"

# ── Helper: seed tasks into the test database ─────────────────────

_seed_task() {
  local tag="$1" title="$2" status="$3" duration="${4:-}"
  _db "INSERT INTO tasks (tag, title, status, duration) VALUES ('$tag', '$title', '$status', '$duration');" 2>/dev/null
}

_clear_tasks() {
  _db "DELETE FROM tasks;" 2>/dev/null
}

# ── 1. Missing inputs: returns error ─────────────────────────────

echo ""
log "=== Error handling: missing inputs ==="

# Test 1: Missing mission file returns error
_rc=0
mission_write_completion_summary "/nonexistent/file.md" "test-slug" "$TMPDIR_ROOT" 2>/dev/null || _rc=$?
assert_eq "$_rc" "1" "error: returns 1 when mission file does not exist"

# Test 2: Output file should NOT be created on error
assert_file_not_exists "$TMPDIR_ROOT/mission-summary-test_slug.md" "error: no output file when mission file missing"

# Test 3: Missing DB returns error
_mission_file="$TMPDIR_ROOT/test-mission.md"
cat > "$_mission_file" << 'MFILE'
# Test Mission
## Success Criteria
- [x] Done
MFILE
_orig_db="$DB_PATH"
DB_PATH="/nonexistent/db"
_rc=0
mission_write_completion_summary "$_mission_file" "no-db" "$TMPDIR_ROOT" 2>/dev/null || _rc=$?
assert_eq "$_rc" "1" "error: returns 1 when database not found"
DB_PATH="$_orig_db"

# ── 2. Basic summary generation ──────────────────────────────────

echo ""
log "=== Basic summary generation ==="

_clear_tasks
_seed_task "FEAT" "Add login" "completed" "10m"
_seed_task "FEAT" "Add signup" "completed" "15m"
_seed_task "FIX"  "Fix crash" "failed" ""
_seed_task "FIX"  "Fix typo" "fixed" "5m"
_seed_task "TEST" "Add tests" "blocked" ""
_seed_task "FEAT" "Add logout" "superseded" ""

_mission_file="$TMPDIR_ROOT/basic-mission.md"
cat > "$_mission_file" << 'MFILE'
# Ship Dashboard v2
## Success Criteria
- [x] Login flow working
- [x] Signup flow working
- [ ] Full test coverage
## Notes
Some notes here.
MFILE

_output=$(mission_write_completion_summary "$_mission_file" "ship-dashboard-v2" "$TMPDIR_ROOT" 2>/dev/null)
_summary_file="$TMPDIR_ROOT/mission-summary-ship_dashboard_v2.md"

# Test 4: Output file created
assert_file_exists "$_summary_file" "basic: summary file created"

# Test 5: Output path returned (last line of stdout; earlier lines may be log output)
_output_last=$(echo "$_output" | tail -1)
assert_eq "$_output_last" "$_summary_file" "basic: returns output file path"

# Test 6: No temp file left behind (atomic write)
_leftover=$(find "$TMPDIR_ROOT" -name "mission-summary-ship_dashboard_v2.md.tmp.*" 2>/dev/null | head -1)
assert_eq "${_leftover:-}" "" "basic: no temp file left behind (atomic write)"

# Read summary content for assertions
_content=$(cat "$_summary_file")

# Test 7: Contains mission title
assert_contains "$_content" "Ship Dashboard v2" "basic: contains mission title"

# Test 8: Contains COMPLETE status
assert_contains "$_content" "COMPLETE" "basic: contains COMPLETE status"

# Test 9: Total tasks count
assert_contains "$_content" "| Total tasks | 6 |" "basic: total tasks = 6"

# Test 10: Completed count (completed + fixed = 3)
assert_contains "$_content" "| Completed | 3 |" "basic: completed = 3 (completed + fixed)"

# Test 11: Failed count (only unresolved failures)
assert_contains "$_content" "| Failed (unresolved) | 1 |" "basic: failed = 1"

# Test 12: Fixed count
assert_contains "$_content" "| Self-corrected (fixed) | 1 |" "basic: fixed = 1"

# Test 13: Blocked count
assert_contains "$_content" "| Blocked | 1 |" "basic: blocked = 1"

# Test 14: Superseded count
assert_contains "$_content" "| Superseded | 1 |" "basic: superseded = 1"

# Test 15: Self-correction rate: fixed/(failed+fixed) = 1/2 = 50%
assert_contains "$_content" "| Self-correction rate | 50% |" "basic: self-correction rate = 50%"

# Test 16: Average duration: (10+15+5)/3 = 10m
assert_contains "$_content" "| Avg task duration | 10m |" "basic: avg duration = 10m"

# Test 17: Success criteria count
assert_contains "$_content" "| Success criteria | 2/3 |" "basic: success criteria = 2/3"

# Test 18: Success criteria checkboxes listed
assert_contains "$_content" "[x] Login flow working" "basic: criteria checkbox listed"

# Test 19: Task breakdown by category header
assert_contains "$_content" "## Task Breakdown by Category" "basic: task breakdown section present"

# Test 20: FEAT category in breakdown
assert_contains "$_content" "| [FEAT] |" "basic: FEAT tag in breakdown"

# Test 21: FIX category in breakdown
assert_contains "$_content" "| [FIX] |" "basic: FIX tag in breakdown"

# Test 22: Generated timestamp present
assert_contains "$_content" "*Generated at" "basic: generated timestamp present"

# ── 3. Self-correction rate edge cases ────────────────────────────

echo ""
log "=== Self-correction rate edge cases ==="

# Test 23: Zero failures and zero fixes = 0% rate
_clear_tasks
_seed_task "FEAT" "Clean task" "completed" "5m"

_mission_file="$TMPDIR_ROOT/no-failures.md"
cat > "$_mission_file" << 'MFILE'
# Clean Mission
## Success Criteria
- [x] All clean
MFILE
mission_write_completion_summary "$_mission_file" "no-failures" "$TMPDIR_ROOT" 2>/dev/null
_content=$(cat "$TMPDIR_ROOT/mission-summary-no_failures.md")
assert_contains "$_content" "| Self-correction rate | 0% |" "rate: 0% when no failures or fixes"

# Test 24: All failures fixed = 100% rate
_clear_tasks
_seed_task "FIX" "Fixed bug 1" "fixed" "3m"
_seed_task "FIX" "Fixed bug 2" "fixed" "4m"

mission_write_completion_summary "$_mission_file" "all-fixed" "$TMPDIR_ROOT" 2>/dev/null
_content=$(cat "$TMPDIR_ROOT/mission-summary-all_fixed.md")
assert_contains "$_content" "| Self-correction rate | 100% |" "rate: 100% when all failures are fixed"

# Test 25: No fixes, only failures = 0% rate
_clear_tasks
_seed_task "FIX" "Failed fix 1" "failed" ""
_seed_task "FIX" "Failed fix 2" "failed" ""

mission_write_completion_summary "$_mission_file" "all-failed" "$TMPDIR_ROOT" 2>/dev/null
_content=$(cat "$TMPDIR_ROOT/mission-summary-all_failed.md")
assert_contains "$_content" "| Self-correction rate | 0% |" "rate: 0% when all fixes failed"

# ── 4. Empty database ────────────────────────────────────────────

echo ""
log "=== Empty database ==="

_clear_tasks

_mission_file="$TMPDIR_ROOT/empty-db.md"
cat > "$_mission_file" << 'MFILE'
# Empty Mission
## Success Criteria
- [ ] Something
MFILE
mission_write_completion_summary "$_mission_file" "empty-db" "$TMPDIR_ROOT" 2>/dev/null
_content=$(cat "$TMPDIR_ROOT/mission-summary-empty_db.md")

# Test 26: Total tasks = 0
assert_contains "$_content" "| Total tasks | 0 |" "empty: total tasks = 0"

# Test 27: Completed = 0
assert_contains "$_content" "| Completed | 0 |" "empty: completed = 0"

# Test 28: No-data fallback in breakdown
assert_contains "$_content" "(no data)" "empty: no-data fallback in breakdown"

# Test 29: Avg duration = 0m
assert_contains "$_content" "| Avg task duration | 0m |" "empty: avg duration = 0m"

# ── 5. Success criteria edge cases ───────────────────────────────

echo ""
log "=== Success criteria edge cases ==="

_clear_tasks
_seed_task "FEAT" "Task" "completed" "5m"

# Test 30: No success criteria section
_mission_file="$TMPDIR_ROOT/no-criteria.md"
cat > "$_mission_file" << 'MFILE'
# No Criteria Mission
## Overview
Just text, no criteria section.
MFILE
mission_write_completion_summary "$_mission_file" "no-criteria" "$TMPDIR_ROOT" 2>/dev/null
_content=$(cat "$TMPDIR_ROOT/mission-summary-no_criteria.md")
assert_contains "$_content" "| Success criteria | 0/0 |" "criteria: 0/0 when no section"
assert_contains "$_content" "(no criteria defined)" "criteria: fallback text when none defined"

# Test 31: All criteria checked
_mission_file="$TMPDIR_ROOT/all-checked.md"
cat > "$_mission_file" << 'MFILE'
# All Checked
## Success Criteria
- [x] First
- [x] Second
MFILE
mission_write_completion_summary "$_mission_file" "all-checked" "$TMPDIR_ROOT" 2>/dev/null
_content=$(cat "$TMPDIR_ROOT/mission-summary-all_checked.md")
assert_contains "$_content" "| Success criteria | 2/2 |" "criteria: 2/2 when all checked"

# Test 32: Uppercase [X] counted
_mission_file="$TMPDIR_ROOT/uppercase-x.md"
cat > "$_mission_file" << 'MFILE'
# Uppercase Test
## Success Criteria
- [X] Uppercase check
- [ ] Unchecked
MFILE
mission_write_completion_summary "$_mission_file" "uppercase-x" "$TMPDIR_ROOT" 2>/dev/null
_content=$(cat "$TMPDIR_ROOT/mission-summary-uppercase_x.md")
assert_contains "$_content" "| Success criteria | 1/2 |" "criteria: uppercase [X] counted as met"

# ── 6. Slug sanitization in output filename ──────────────────────

echo ""
log "=== Slug sanitization ==="

_clear_tasks
_seed_task "FEAT" "Task" "completed" "5m"

_mission_file="$TMPDIR_ROOT/slug-test.md"
cat > "$_mission_file" << 'MFILE'
# Slug Test
## Success Criteria
- [x] Done
MFILE

# Test 33: Dashes become underscores in filename
mission_write_completion_summary "$_mission_file" "my-cool-slug" "$TMPDIR_ROOT" 2>/dev/null
assert_file_exists "$TMPDIR_ROOT/mission-summary-my_cool_slug.md" "slug: dashes become underscores"

# Test 34: Dots and slashes become underscores
mission_write_completion_summary "$_mission_file" "v2.0/prod" "$TMPDIR_ROOT" 2>/dev/null
assert_file_exists "$TMPDIR_ROOT/mission-summary-v2_0_prod.md" "slug: dots and slashes sanitized"

# ── 7. Mission title extraction ──────────────────────────────────

echo ""
log "=== Mission title extraction ==="

# Test 35: Title from # heading
_mission_file="$TMPDIR_ROOT/title-test.md"
cat > "$_mission_file" << 'MFILE'
# My Awesome Mission
## Success Criteria
- [x] Done
MFILE
mission_write_completion_summary "$_mission_file" "title-test" "$TMPDIR_ROOT" 2>/dev/null
_content=$(cat "$TMPDIR_ROOT/mission-summary-title_test.md")
assert_contains "$_content" "My Awesome Mission" "title: extracted from # heading"

# Test 36: Falls back to slug when no heading
_mission_file="$TMPDIR_ROOT/no-title.md"
cat > "$_mission_file" << 'MFILE'
## Success Criteria
- [x] Done
MFILE
mission_write_completion_summary "$_mission_file" "fallback-slug" "$TMPDIR_ROOT" 2>/dev/null
_content=$(cat "$TMPDIR_ROOT/mission-summary-fallback_slug.md")
assert_contains "$_content" "fallback-slug" "title: falls back to slug when no heading"

# ── 8. Overwrite existing summary ────────────────────────────────

echo ""
log "=== Overwrite behavior ==="

_clear_tasks
_seed_task "FEAT" "Initial" "completed" "5m"

_mission_file="$TMPDIR_ROOT/overwrite.md"
cat > "$_mission_file" << 'MFILE'
# Overwrite Test
## Success Criteria
- [x] Done
MFILE

# Write first summary
mission_write_completion_summary "$_mission_file" "overwrite" "$TMPDIR_ROOT" 2>/dev/null
_first=$(cat "$TMPDIR_ROOT/mission-summary-overwrite.md")

# Add more tasks and overwrite
_seed_task "FIX" "Another" "failed" ""
mission_write_completion_summary "$_mission_file" "overwrite" "$TMPDIR_ROOT" 2>/dev/null
_second=$(cat "$TMPDIR_ROOT/mission-summary-overwrite.md")

# Test 37: Content changed after overwrite
assert_contains "$_second" "| Total tasks | 2 |" "overwrite: updated content reflects new data"
assert_contains "$_first" "| Total tasks | 1 |" "overwrite: original had old data"

# ── 9. Average duration with mixed data ──────────────────────────

echo ""
log "=== Average duration edge cases ==="

_clear_tasks
_seed_task "FEAT" "Fast" "completed" "2m"
_seed_task "FEAT" "Slow" "completed" "8m"
_seed_task "FIX"  "No dur" "completed" ""
_seed_task "FIX"  "Failed" "failed" "20m"

_mission_file="$TMPDIR_ROOT/duration.md"
cat > "$_mission_file" << 'MFILE'
# Duration Test
## Success Criteria
- [x] Done
MFILE
mission_write_completion_summary "$_mission_file" "duration" "$TMPDIR_ROOT" 2>/dev/null
_content=$(cat "$TMPDIR_ROOT/mission-summary-duration.md")

# Test 38: Avg only includes completed/fixed with duration: (2+8)/2 = 5
assert_contains "$_content" "| Avg task duration | 5m |" "duration: averages only completed tasks with duration"

# Test 39: Failed task durations excluded from average
assert_not_contains "$_content" "| Avg task duration | 10m |" "duration: failed task durations excluded"

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
