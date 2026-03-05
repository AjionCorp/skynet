#!/usr/bin/env bash
# tests/unit/mission-done-transition.test.sh — Regression for mission DONE transition
#
# Tests the full DONE transition when all success criteria checkboxes are checked:
#   - mission_evaluate_criteria returns "complete" when all [x] and pending=0
#   - mission_set_state transitions to "complete" state
#   - State line written/updated in mission file
#   - Sentinel file created with correct JSON
#   - Completion summary written via mission_write_completion_summary
#   - Idempotency: sentinel prevents re-triggering
#   - Edge cases: uppercase [X], mixed bullets, reviewing→complete transition
#
# Usage: bash tests/unit/mission-done-transition.test.sh

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
  if [ "$actual" = "$expected" ]; then pass "$msg"
  else fail "$msg (expected '$expected', got '$actual')"; fi
}

assert_contains() {
  local haystack="$1" needle="$2" msg="$3"
  if printf '%s' "$haystack" | grep -qF "$needle"; then pass "$msg"
  else fail "$msg (expected to contain '$needle')"; fi
}

assert_file_exists() {
  local path="$1" msg="$2"
  if [ -f "$path" ]; then pass "$msg"
  else fail "$msg (file not found: $path)"; fi
}

assert_file_not_exists() {
  local path="$1" msg="$2"
  if [ ! -f "$path" ]; then pass "$msg"
  else fail "$msg (file unexpectedly exists: $path)"; fi
}

# ── Setup: create isolated environment ──────────────────────────────

TMPDIR_ROOT=$(mktemp -d)
cleanup() { rm -rf "$TMPDIR_ROOT"; }
trap cleanup EXIT

export SKYNET_PROJECT_DIR="$TMPDIR_ROOT"
export SKYNET_DEV_DIR="$TMPDIR_ROOT/.dev"
export SKYNET_PROJECT_NAME="test-done-transition"
export SKYNET_LOCK_PREFIX="/tmp/skynet-test-done-$$"
export SKYNET_STALE_MINUTES=45
export SKYNET_MAX_WORKERS=4
export SKYNET_MAIN_BRANCH="main"

mkdir -p "$SKYNET_DEV_DIR/missions"

# Stub log() for sourcing
log() { :; }

# Source _db.sh (sets DB_PATH, defines _db, _db_sep, db_init)
source "$REPO_ROOT/scripts/_db.sh"

# Stub _generate_trace_id if needed
_generate_trace_id() { printf '%s' "test-$$-$(date +%s)"; }

# Initialize DB
db_init

# Source mission-state.sh (defines mission_evaluate_criteria, mission_set_state, etc.)
source "$REPO_ROOT/scripts/mission-state.sh"

# Restore log for test output
log() { printf "  %s\n" "$*"; }

set +e  # Disable errexit for test assertions

echo "mission-done-transition.test.sh — regression for mission DONE transition"

# ── Helper: seed tasks ─────────────────────────────────────────────

_seed_task() {
  local tag="$1" title="$2" status="$3" duration="${4:-}" mission_hash="${5:-}"
  _db "INSERT INTO tasks (tag, title, status, duration, mission_hash) VALUES ('$tag', '$title', '$status', '$duration', '$mission_hash');" 2>/dev/null
}

_clear_tasks() {
  _db "DELETE FROM tasks;" 2>/dev/null
}

# ── 1. mission_evaluate_criteria → "complete" ──────────────────────

echo ""
log "=== mission_evaluate_criteria: all checked + zero pending = complete ==="

_mf="$TMPDIR_ROOT/m1.md"
cat > "$_mf" << 'MFILE'
# Ship Dashboard v2
## Success Criteria
- [x] Dashboard renders correctly
- [x] All API routes working
- [x] Tests passing
MFILE

_result=$(mission_evaluate_criteria "$_mf" 0)
assert_eq "$_result" "complete" "evaluate: all [x] + pending=0 → complete"

# ── 2. Complete even when pending > 0 (criteria trump pending count) ─

echo ""
log "=== mission_evaluate_criteria: all checked + pending > 0 = still complete ==="

# When all criteria are met, the function returns "complete" regardless of pending.
# The pending_count only affects the reviewing vs active decision for unmet criteria.
_result=$(mission_evaluate_criteria "$_mf" 3)
assert_eq "$_result" "complete" "evaluate: all [x] + pending=3 → complete (criteria trump pending)"

# ── 3. NOT complete when partial criteria ──────────────────────────

echo ""
log "=== mission_evaluate_criteria: partial criteria = active ==="

_mf2="$TMPDIR_ROOT/m2.md"
cat > "$_mf2" << 'MFILE'
# Partial Mission
## Success Criteria
- [x] First done
- [ ] Second pending
- [x] Third done
MFILE

_result=$(mission_evaluate_criteria "$_mf2" 0)
assert_eq "$_result" "reviewing" "evaluate: 2/3 checked + pending=0 → reviewing"

_result=$(mission_evaluate_criteria "$_mf2" 2)
assert_eq "$_result" "active" "evaluate: 2/3 checked + pending=2 → active"

# ── 4. Uppercase [X] counted as met ───────────────────────────────

echo ""
log "=== mission_evaluate_criteria: uppercase [X] ==="

_mf3="$TMPDIR_ROOT/m3.md"
cat > "$_mf3" << 'MFILE'
# Uppercase Test
## Success Criteria
- [X] First criterion
- [x] Second criterion
MFILE

_result=$(mission_evaluate_criteria "$_mf3" 0)
assert_eq "$_result" "complete" "evaluate: [X] and [x] both count → complete"

# ── 5. Asterisk bullets ───────────────────────────────────────────

echo ""
log "=== mission_evaluate_criteria: asterisk bullets ==="

_mf4="$TMPDIR_ROOT/m4.md"
cat > "$_mf4" << 'MFILE'
# Asterisk Mission
## Success Criteria
* [x] First with asterisk
* [x] Second with asterisk
MFILE

_result=$(mission_evaluate_criteria "$_mf4" 0)
assert_eq "$_result" "complete" "evaluate: asterisk bullets → complete"

# ── 6. mission_set_state: active → complete ────────────────────────

echo ""
log "=== mission_set_state: active → complete transition ==="

_mf5="$TMPDIR_ROOT/m5.md"
cat > "$_mf5" << 'MFILE'
# State Transition Test
## State: active
## Success Criteria
- [x] All done
MFILE

_state_before=$(mission_get_state "$_mf5")
assert_eq "$_state_before" "active" "set_state: starts as active"

mission_set_state "$_mf5" "complete" "test"
_state_after=$(mission_get_state "$_mf5")
assert_eq "$_state_after" "complete" "set_state: transitions to complete"

# Verify the file was actually updated
_file_content=$(cat "$_mf5")
assert_contains "$_file_content" "## State: complete" "set_state: file contains '## State: complete' line"

# ── 7. mission_set_state: reviewing → complete ─────────────────────

echo ""
log "=== mission_set_state: reviewing → complete transition ==="

_mf6="$TMPDIR_ROOT/m6.md"
cat > "$_mf6" << 'MFILE'
# Reviewing to Complete
## State: reviewing
## Success Criteria
- [x] Everything reviewed
MFILE

mission_set_state "$_mf6" "complete" "test"
_state=$(mission_get_state "$_mf6")
assert_eq "$_state" "complete" "set_state: reviewing → complete works"

# ── 8. mission_is_terminal: complete is terminal ──────────────────

echo ""
log "=== mission_is_terminal ==="

if mission_is_terminal "complete"; then
  pass "is_terminal: complete is terminal"
else
  fail "is_terminal: complete should be terminal"
fi

if mission_is_terminal "active"; then
  fail "is_terminal: active should NOT be terminal"
else
  pass "is_terminal: active is not terminal"
fi

# ── 9. Sentinel file creation (mirrors project-driver.sh) ─────────

echo ""
log "=== Sentinel file lifecycle ==="

_sentinel_dir="$TMPDIR_ROOT/.dev"
_mission_hash="ship-v2"
_mission_id_safe=$(echo "$_mission_hash" | sed 's/[^a-zA-Z0-9]/_/g')
_sentinel="$_sentinel_dir/mission-complete-${_mission_id_safe}"

assert_file_not_exists "$_sentinel" "sentinel: does not exist before DONE transition"

# Simulate the sentinel creation as project-driver.sh does (line 580)
_mission_name="Ship Dashboard v2"
mc_total_criteria=3
echo "{\"completedAt\": \"$(date -u '+%Y-%m-%dT%H:%M:%SZ')\", \"mission\": \"$_mission_name\", \"slug\": \"$_mission_hash\", \"criteriaCount\": $mc_total_criteria}" > "$_sentinel"

assert_file_exists "$_sentinel" "sentinel: created after DONE transition"

# Verify sentinel content
_sentinel_content=$(cat "$_sentinel")
assert_contains "$_sentinel_content" '"completedAt"' "sentinel: contains completedAt"
assert_contains "$_sentinel_content" '"mission": "Ship Dashboard v2"' "sentinel: contains mission name"
assert_contains "$_sentinel_content" '"slug": "ship-v2"' "sentinel: contains slug"
assert_contains "$_sentinel_content" '"criteriaCount": 3' "sentinel: contains criteriaCount"

# ── 10. Sentinel prevents re-detection (idempotency) ──────────────

echo ""
log "=== Sentinel idempotency ==="

# Mirrors project-driver.sh line 534: if [ ! -f "$MISSION_COMPLETE_SENTINEL" ]; then ...
_would_run="no"
if [ ! -f "$_sentinel" ]; then
  _would_run="yes"
fi
assert_eq "$_would_run" "no" "idempotency: existing sentinel skips completion block"

# Remove sentinel — now it would run
rm "$_sentinel"
if [ ! -f "$_sentinel" ]; then
  _would_run="yes"
fi
assert_eq "$_would_run" "yes" "idempotency: missing sentinel allows completion block"

# ── 11. Completion summary written ────────────────────────────────

echo ""
log "=== Completion summary via mission_write_completion_summary ==="

_clear_tasks
_seed_task "FEAT" "Add login" "completed" "10m" "done-test"
_seed_task "FEAT" "Add signup" "completed" "15m" "done-test"
_seed_task "TEST" "Add tests" "completed" "8m" "done-test"

_mf7="$TMPDIR_ROOT/done-summary.md"
cat > "$_mf7" << 'MFILE'
# Done Summary Mission
## State: active
## Success Criteria
- [x] Login flow working
- [x] Signup flow working
- [x] Tests passing
MFILE

# Evaluate → should be complete
_result=$(mission_evaluate_criteria "$_mf7" 0)
assert_eq "$_result" "complete" "summary: criteria evaluate to complete"

# Transition state
mission_set_state "$_mf7" "complete" "test"

# Write summary
_output=$(mission_write_completion_summary "$_mf7" "done-test" "$TMPDIR_ROOT" 2>/dev/null)
_summary_file="$TMPDIR_ROOT/mission-summary-done_test.md"

assert_file_exists "$_summary_file" "summary: file created on DONE transition"

_content=$(cat "$_summary_file")
assert_contains "$_content" "Done Summary Mission" "summary: contains mission title"
assert_contains "$_content" "COMPLETE" "summary: contains COMPLETE status"
assert_contains "$_content" "| Total tasks | 3 |" "summary: correct total tasks"
assert_contains "$_content" "| Completed | 3 |" "summary: correct completed count"
assert_contains "$_content" "| Success criteria | 3/3 |" "summary: 3/3 criteria met"

# ── 12. Full end-to-end DONE transition ───────────────────────────

echo ""
log "=== Full end-to-end: evaluate → set_state → sentinel → summary ==="

_clear_tasks
_seed_task "FEAT" "Implement API" "completed" "20m" "e2e-mission"
_seed_task "FEAT" "Build UI" "completed" "30m" "e2e-mission"
_seed_task "TEST" "Write tests" "completed" "15m" "e2e-mission"
_seed_task "FIX" "Fix auth bug" "fixed" "10m" "e2e-mission"
_seed_task "FIX" "Fix crash" "failed" "" "e2e-mission"

_mf_e2e="$TMPDIR_ROOT/e2e-mission.md"
cat > "$_mf_e2e" << 'MFILE'
# End-to-End Mission
## State: active
## Success Criteria
- [x] API endpoints implemented
- [x] Dashboard renders correctly
- [x] Tests passing
- [x] Auth flow working
## Notes
These notes should not be parsed as criteria.
MFILE

_e2e_hash="e2e-mission"
_e2e_id_safe=$(echo "$_e2e_hash" | sed 's/[^a-zA-Z0-9]/_/g')
_e2e_sentinel="$TMPDIR_ROOT/.dev/mission-complete-${_e2e_id_safe}"

# Step 1: Verify sentinel doesn't exist
assert_file_not_exists "$_e2e_sentinel" "e2e: sentinel absent before transition"

# Step 2: Evaluate criteria
_e2e_pending=0
_e2e_result=$(mission_evaluate_criteria "$_mf_e2e" "$_e2e_pending")
assert_eq "$_e2e_result" "complete" "e2e: all 4 criteria met → complete"

# Step 3: Set state to complete
mission_set_state "$_mf_e2e" "complete" "test-e2e"
_e2e_state=$(mission_get_state "$_mf_e2e")
assert_eq "$_e2e_state" "complete" "e2e: state set to complete"

# Step 4: Parse criteria for notification (mirrors project-driver.sh lines 554-556)
_e2e_raw=$(sed -n '/^## Success Criteria/,/^## /p' "$_mf_e2e" \
  | grep '^[-*][[:space:]]*\[[ xX]\]' || true)
_e2e_total=$(echo "$_e2e_raw" | wc -l | grep -oE '[0-9]+' | head -1)
assert_eq "$_e2e_total" "4" "e2e: parsed 4 criteria total"

# Step 5: Write sentinel (mirrors project-driver.sh line 580)
_e2e_name="End-to-End Mission"
echo "{\"completedAt\": \"$(date -u '+%Y-%m-%dT%H:%M:%SZ')\", \"mission\": \"$_e2e_name\", \"slug\": \"$_e2e_hash\", \"criteriaCount\": $_e2e_total}" > "$_e2e_sentinel"
assert_file_exists "$_e2e_sentinel" "e2e: sentinel written"

# Step 6: Write completion summary
_e2e_output=$(mission_write_completion_summary "$_mf_e2e" "$_e2e_hash" "$TMPDIR_ROOT" 2>/dev/null)
_e2e_summary="$TMPDIR_ROOT/mission-summary-${_e2e_id_safe}.md"
assert_file_exists "$_e2e_summary" "e2e: completion summary written"

_e2e_content=$(cat "$_e2e_summary")
assert_contains "$_e2e_content" "End-to-End Mission" "e2e: summary has mission title"
assert_contains "$_e2e_content" "| Total tasks | 5 |" "e2e: summary has correct total"
assert_contains "$_e2e_content" "| Completed | 4 |" "e2e: summary has correct completed (3 completed + 1 fixed)"
assert_contains "$_e2e_content" "| Failed (unresolved) | 1 |" "e2e: summary has correct failed count"
assert_contains "$_e2e_content" "| Success criteria | 4/4 |" "e2e: summary shows 4/4 criteria"

# Step 7: Sentinel blocks re-detection
_e2e_blocked="no"
if [ ! -f "$_e2e_sentinel" ]; then
  _e2e_blocked="would-run"
else
  _e2e_blocked="blocked"
fi
assert_eq "$_e2e_blocked" "blocked" "e2e: sentinel prevents re-detection"

# ── 13. No criteria section = no transition ───────────────────────

echo ""
log "=== No criteria section: no DONE transition ==="

_mf_nc="$TMPDIR_ROOT/no-criteria.md"
cat > "$_mf_nc" << 'MFILE'
# No Criteria Mission
## Overview
Just a description, no success criteria.
MFILE

_nc_result=$(mission_evaluate_criteria "$_mf_nc" 0)
assert_eq "$_nc_result" "" "no-criteria: evaluate returns empty (no transition)"

# ── 14. State: draft → cannot go to complete directly without active ─

echo ""
log "=== State transitions: draft file gets state set ==="

_mf_draft="$TMPDIR_ROOT/draft-mission.md"
cat > "$_mf_draft" << 'MFILE'
# Draft Mission
## Success Criteria
- [x] Everything done
MFILE

# File has no State: line → defaults to "draft"
_draft_state=$(mission_get_state "$_mf_draft")
assert_eq "$_draft_state" "draft" "draft: file without State line defaults to draft"

# Set state to complete (transition validation is audit-only, non-blocking)
mission_set_state "$_mf_draft" "complete" "test"
_new_state=$(mission_get_state "$_mf_draft")
assert_eq "$_new_state" "complete" "draft: state can be set to complete (audit-only validation)"

# Verify ## State: complete was inserted into the file
_draft_content=$(cat "$_mf_draft")
assert_contains "$_draft_content" "## State: complete" "draft: State line inserted after title"

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
