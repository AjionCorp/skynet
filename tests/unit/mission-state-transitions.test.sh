#!/usr/bin/env bash
# tests/unit/mission-state-transitions.test.sh — Edge cases for mission state transitions
#
# Tests the state machine edge cases NOT covered by mission-state.test.sh or
# mission-done-transition.test.sh:
#   - All valid transitions (draft→active, active→paused, paused→active, etc.)
#   - Invalid transitions emit warnings (draft→paused, paused→reviewing, etc.)
#   - Terminal state enforcement (complete→anything, failed→anything except draft)
#   - Same-state no-op transitions
#   - Empty from_state bypass
#   - failed→draft re-plan path
#   - mission_set_state on missing file
#   - mission_get_state with unknown/invalid state values
#   - mission_get_state with legacy format (no ## prefix)
#   - mission_is_workable for all states
#   - mission_is_valid_state coverage
#   - State line insertion when no heading exists
#   - State line replacement with legacy format
#
# Usage: bash tests/unit/mission-state-transitions.test.sh

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
  else fail "$msg (expected to contain '$needle', got '$haystack')"; fi
}

assert_not_contains() {
  local haystack="$1" needle="$2" msg="$3"
  if ! printf '%s' "$haystack" | grep -qF "$needle"; then pass "$msg"
  else fail "$msg (should NOT contain '$needle')"; fi
}

# ── Setup: create isolated environment ──────────────────────────────

TMPDIR_ROOT=$(mktemp -d)
cleanup() { rm -rf "$TMPDIR_ROOT"; }
trap cleanup EXIT

export SKYNET_DEV_DIR="$TMPDIR_ROOT/dev"
mkdir -p "$SKYNET_DEV_DIR/missions"
cat > "$SKYNET_DEV_DIR/skynet.config.sh" << CONF
export SKYNET_PROJECT_NAME="test-transitions"
export SKYNET_PROJECT_DIR="$TMPDIR_ROOT/project"
export SKYNET_DEV_DIR="$SKYNET_DEV_DIR"
CONF
mkdir -p "$TMPDIR_ROOT/project"

cd "$REPO_ROOT"
source scripts/_config.sh 2>/dev/null || true
set +e  # _config.sh enables errexit; disable for test assertions

# Re-source mission-state.sh to pick up functions
source scripts/mission-state.sh

echo "mission-state-transitions.test.sh — edge cases for mission state transitions"

# ── 1. mission_is_valid_state: all valid states ─────────────────────

echo ""
log "=== mission_is_valid_state: exhaustive coverage ==="

for _s in draft active paused reviewing complete failed; do
  if mission_is_valid_state "$_s"; then
    pass "is_valid_state: '$_s' is valid"
  else
    fail "is_valid_state: '$_s' should be valid"
  fi
done

for _s in "pending" "running" "done" "canceled" "ACTIVE" "Draft" "" "unknown"; do
  if mission_is_valid_state "$_s"; then
    fail "is_valid_state: '$_s' should be invalid"
  else
    pass "is_valid_state: '$_s' is invalid"
  fi
done

# ── 2. mission_is_terminal: all states ──────────────────────────────

echo ""
log "=== mission_is_terminal: exhaustive coverage ==="

if mission_is_terminal "complete"; then
  pass "is_terminal: complete is terminal"
else
  fail "is_terminal: complete should be terminal"
fi

for _s in draft active paused reviewing failed; do
  if mission_is_terminal "$_s"; then
    fail "is_terminal: '$_s' should NOT be terminal"
  else
    pass "is_terminal: '$_s' is not terminal"
  fi
done

# ── 3. mission_validate_transition: all valid transitions ───────────

echo ""
log "=== mission_validate_transition: valid transitions produce no warnings ==="

# Capture stderr to check for warnings
_check_valid_transition() {
  local from="$1" to="$2"
  local _output
  _output=$(mission_validate_transition "test-slug" "$from" "$to" "unit-test" 2>&1)
  if ! printf '%s' "$_output" | grep -q "WARNING"; then
    pass "valid transition: $from → $to (no warning)"
  else
    fail "valid transition: $from → $to (unexpected warning: $_output)"
  fi
}

_check_valid_transition "draft" "active"
_check_valid_transition "draft" "failed"
_check_valid_transition "active" "paused"
_check_valid_transition "active" "reviewing"
_check_valid_transition "active" "complete"
_check_valid_transition "active" "failed"
_check_valid_transition "paused" "active"
_check_valid_transition "paused" "failed"
_check_valid_transition "reviewing" "active"
_check_valid_transition "reviewing" "complete"
_check_valid_transition "reviewing" "failed"
_check_valid_transition "failed" "draft"

# ── 4. mission_validate_transition: invalid transitions emit warnings ─

echo ""
log "=== mission_validate_transition: invalid transitions emit warnings ==="

_check_invalid_transition() {
  local from="$1" to="$2"
  local _output
  # log() is defined as stdout, so warnings go to stdout; also capture stderr
  _output=$(mission_validate_transition "test-slug" "$from" "$to" "unit-test" 2>&1)
  if printf '%s' "$_output" | grep -q "WARNING"; then
    pass "invalid transition: $from → $to (warning emitted)"
  else
    fail "invalid transition: $from → $to (expected WARNING, got: '$_output')"
  fi
}

_check_invalid_transition "draft" "paused"
_check_invalid_transition "draft" "reviewing"
_check_invalid_transition "draft" "complete"
_check_invalid_transition "paused" "reviewing"
_check_invalid_transition "paused" "complete"
# Note: paused→paused is same-state, handled as no-op (tested in section 5)
_check_invalid_transition "complete" "active"
_check_invalid_transition "complete" "paused"
_check_invalid_transition "complete" "failed"
_check_invalid_transition "complete" "draft"
_check_invalid_transition "failed" "active"
_check_invalid_transition "failed" "paused"
_check_invalid_transition "failed" "reviewing"
_check_invalid_transition "failed" "complete"

# ── 5. mission_validate_transition: same-state = no-op ──────────────

echo ""
log "=== mission_validate_transition: same-state transitions are no-ops ==="

for _s in draft active paused reviewing complete failed; do
  _stderr=$(mission_validate_transition "test-slug" "$_s" "$_s" "unit-test" 2>&1 >/dev/null)
  if [ -z "$_stderr" ]; then
    pass "same-state no-op: $_s → $_s (no warning)"
  else
    fail "same-state no-op: $_s → $_s (unexpected warning)"
  fi
done

# ── 6. mission_validate_transition: empty from_state bypasses ───────

echo ""
log "=== mission_validate_transition: empty from_state bypasses validation ==="

_stderr=$(mission_validate_transition "test-slug" "" "active" "unit-test" 2>&1 >/dev/null)
assert_eq "$_stderr" "" "empty from_state: bypass validation (no warning)"

_stderr=$(mission_validate_transition "test-slug" "" "complete" "unit-test" 2>&1 >/dev/null)
assert_eq "$_stderr" "" "empty from_state: bypass even for terminal target"

# ── 7. mission_get_state: various file formats ──────────────────────

echo ""
log "=== mission_get_state: file format handling ==="

# Canonical format: ## State: active
_tf="$TMPDIR_ROOT/state-canonical.md"
printf '# Mission\n## State: active\n## Goals\n' > "$_tf"
_state=$(mission_get_state "$_tf")
assert_eq "$_state" "active" "get_state: canonical '## State: active'"

# Legacy format: State: paused (no ## prefix)
_tf="$TMPDIR_ROOT/state-legacy.md"
printf '# Mission\nState: paused\n## Goals\n' > "$_tf"
_state=$(mission_get_state "$_tf")
assert_eq "$_state" "paused" "get_state: legacy 'State: paused'"

# Case insensitive: state: reviewing
_tf="$TMPDIR_ROOT/state-case.md"
printf '# Mission\n## state: reviewing\n' > "$_tf"
_state=$(mission_get_state "$_tf")
assert_eq "$_state" "reviewing" "get_state: case insensitive '## state:'"

# No state line → defaults to draft
_tf="$TMPDIR_ROOT/state-missing.md"
printf '# Mission\n## Goals\nSome goals\n' > "$_tf"
_state=$(mission_get_state "$_tf")
assert_eq "$_state" "draft" "get_state: no state line defaults to draft"

# Nonexistent file → empty (no error)
_state=$(mission_get_state "$TMPDIR_ROOT/nonexistent.md")
assert_eq "$_state" "" "get_state: nonexistent file returns empty"

# State with trailing whitespace
_tf="$TMPDIR_ROOT/state-trailing.md"
printf '# Mission\n## State: active   \n' > "$_tf"
_state=$(mission_get_state "$_tf")
assert_eq "$_state" "active" "get_state: trims trailing whitespace"

# Invalid/unknown state value — warning goes to stdout via log(), so filter it
_tf="$TMPDIR_ROOT/state-unknown.md"
printf '# Mission\n## State: bogus\n' > "$_tf"
_state=$(mission_get_state "$_tf" 2>/dev/null | tail -1)
assert_eq "$_state" "bogus" "get_state: returns unknown state as-is (caller handles)"

# Empty file → defaults to draft
_tf="$TMPDIR_ROOT/state-empty.md"
: > "$_tf"
_state=$(mission_get_state "$_tf")
assert_eq "$_state" "draft" "get_state: empty file defaults to draft"

# ── 8. mission_set_state: full transition matrix ────────────────────

echo ""
log "=== mission_set_state: state file mutations ==="

# active → paused
_tf="$TMPDIR_ROOT/set-active-paused.md"
printf '# Test\n## State: active\n' > "$_tf"
mission_set_state "$_tf" "paused" "test" 2>/dev/null
assert_eq "$(mission_get_state "$_tf")" "paused" "set_state: active → paused"

# paused → active
mission_set_state "$_tf" "active" "test" 2>/dev/null
assert_eq "$(mission_get_state "$_tf")" "active" "set_state: paused → active"

# active → reviewing
mission_set_state "$_tf" "reviewing" "test" 2>/dev/null
assert_eq "$(mission_get_state "$_tf")" "reviewing" "set_state: active → reviewing"

# reviewing → active (bounce back)
mission_set_state "$_tf" "active" "test" 2>/dev/null
assert_eq "$(mission_get_state "$_tf")" "active" "set_state: reviewing → active"

# active → failed
mission_set_state "$_tf" "failed" "test" 2>/dev/null
assert_eq "$(mission_get_state "$_tf")" "failed" "set_state: active → failed"

# failed → draft (re-plan)
mission_set_state "$_tf" "draft" "test" 2>/dev/null
assert_eq "$(mission_get_state "$_tf")" "draft" "set_state: failed → draft (re-plan)"

# draft → active
mission_set_state "$_tf" "active" "test" 2>/dev/null
assert_eq "$(mission_get_state "$_tf")" "active" "set_state: draft → active"

# active → complete
mission_set_state "$_tf" "complete" "test" 2>/dev/null
assert_eq "$(mission_get_state "$_tf")" "complete" "set_state: active → complete"

# ── 9. mission_set_state: missing file returns error ────────────────

echo ""
log "=== mission_set_state: error handling ==="

_result=$(mission_set_state "$TMPDIR_ROOT/nonexistent.md" "active" "test" 2>/dev/null; echo $?)
# Last line is the exit code
_exit_code=$(echo "$_result" | tail -1)
assert_eq "$_exit_code" "1" "set_state: nonexistent file returns exit code 1"

# ── 10. mission_set_state: inserting state line (no existing state) ─

echo ""
log "=== mission_set_state: state line insertion ==="

# File with heading but no state line → inserts after heading
_tf="$TMPDIR_ROOT/insert-after-heading.md"
printf '# My Mission\n## Goals\n- Goal one\n' > "$_tf"
mission_set_state "$_tf" "active" "test" 2>/dev/null
_content=$(cat "$_tf")
assert_contains "$_content" "## State: active" "insert: state line added to file"
# Verify it appears after the title
_first_line=$(head -1 "$_tf")
assert_eq "$_first_line" "# My Mission" "insert: title still first line"
_second_line=$(sed -n '2p' "$_tf")
assert_eq "$_second_line" "## State: active" "insert: state line inserted after title"

# File without any heading → prepends state line
_tf="$TMPDIR_ROOT/insert-no-heading.md"
printf 'Just some text\nNo heading here\n' > "$_tf"
mission_set_state "$_tf" "paused" "test" 2>/dev/null
_first_line=$(head -1 "$_tf")
assert_eq "$_first_line" "## State: paused" "insert: state prepended when no heading"

# ── 11. mission_set_state: legacy format gets upgraded ──────────────

echo ""
log "=== mission_set_state: legacy format upgrade ==="

_tf="$TMPDIR_ROOT/legacy-upgrade.md"
printf '# Legacy Mission\nState: active\n## Goals\n' > "$_tf"
_state=$(mission_get_state "$_tf")
assert_eq "$_state" "active" "legacy upgrade: reads legacy State: format"

mission_set_state "$_tf" "reviewing" "test" 2>/dev/null
_state=$(mission_get_state "$_tf")
assert_eq "$_state" "reviewing" "legacy upgrade: transitions correctly"
_content=$(cat "$_tf")
assert_contains "$_content" "## State: reviewing" "legacy upgrade: format upgraded to ## State:"

# ── 12. mission_is_workable: all states ─────────────────────────────

echo ""
log "=== mission_is_workable: state coverage ==="

# We need to test mission_is_workable by setting up MISSION env var
_wk_file="$TMPDIR_ROOT/workable-test.md"

for _s in draft active; do
  printf '# Workable Test\n## State: %s\n' "$_s" > "$_wk_file"
  MISSION="$_wk_file" mission_is_workable
  if [ $? -eq 0 ]; then
    pass "is_workable: '$_s' is workable"
  else
    fail "is_workable: '$_s' should be workable"
  fi
done

for _s in paused reviewing complete failed; do
  printf '# Workable Test\n## State: %s\n' "$_s" > "$_wk_file"
  MISSION="$_wk_file" mission_is_workable
  if [ $? -ne 0 ]; then
    pass "is_workable: '$_s' is NOT workable"
  else
    fail "is_workable: '$_s' should NOT be workable"
  fi
done

# ── 13. mission_evaluate_criteria: edge cases ───────────────────────

echo ""
log "=== mission_evaluate_criteria: boundary conditions ==="

# No criteria section → empty (no state change)
_tf="$TMPDIR_ROOT/eval-no-criteria.md"
printf '# No Criteria\n## Goals\nSome goals\n' > "$_tf"
_result=$(mission_evaluate_criteria "$_tf" 0)
assert_eq "$_result" "" "evaluate: no criteria section → empty"

# Empty criteria section (has heading but no checkboxes)
_tf="$TMPDIR_ROOT/eval-empty-criteria.md"
printf '# Empty Criteria\n## Success Criteria\nJust text, no checkboxes.\n## Notes\n' > "$_tf"
_result=$(mission_evaluate_criteria "$_tf" 0)
assert_eq "$_result" "" "evaluate: no checkboxes → empty"

# Single criterion checked, pending=0 → complete
_tf="$TMPDIR_ROOT/eval-single.md"
printf '# Single\n## Success Criteria\n- [x] Only one\n' > "$_tf"
_result=$(mission_evaluate_criteria "$_tf" 0)
assert_eq "$_result" "complete" "evaluate: single [x] + pending=0 → complete"

# All unchecked, pending=0 → reviewing
_tf="$TMPDIR_ROOT/eval-all-unchecked.md"
printf '# Unchecked\n## Success Criteria\n- [ ] First\n- [ ] Second\n' > "$_tf"
_result=$(mission_evaluate_criteria "$_tf" 0)
assert_eq "$_result" "reviewing" "evaluate: all unchecked + pending=0 → reviewing"

# All unchecked, pending>0 → active
_result=$(mission_evaluate_criteria "$_tf" 5)
assert_eq "$_result" "active" "evaluate: all unchecked + pending=5 → active"

# Nonexistent file → empty
_result=$(mission_evaluate_criteria "$TMPDIR_ROOT/nonexistent.md" 0)
assert_eq "$_result" "" "evaluate: nonexistent file → empty"

# ── 14. Round-trip: draft → active → paused → active → reviewing → complete ─

echo ""
log "=== Round-trip: full state machine path ==="

_tf="$TMPDIR_ROOT/roundtrip.md"
printf '# Round Trip Mission\n## Success Criteria\n- [ ] All done\n' > "$_tf"

# Starts as draft (no state line)
assert_eq "$(mission_get_state "$_tf")" "draft" "roundtrip: starts as draft"

# draft → active
mission_set_state "$_tf" "active" "test" 2>/dev/null
assert_eq "$(mission_get_state "$_tf")" "active" "roundtrip: draft → active"

# active → paused
mission_set_state "$_tf" "paused" "test" 2>/dev/null
assert_eq "$(mission_get_state "$_tf")" "paused" "roundtrip: active → paused"

# paused → active
mission_set_state "$_tf" "active" "test" 2>/dev/null
assert_eq "$(mission_get_state "$_tf")" "active" "roundtrip: paused → active"

# active → reviewing
mission_set_state "$_tf" "reviewing" "test" 2>/dev/null
assert_eq "$(mission_get_state "$_tf")" "reviewing" "roundtrip: active → reviewing"

# reviewing → active (bounce back for more work)
mission_set_state "$_tf" "active" "test" 2>/dev/null
assert_eq "$(mission_get_state "$_tf")" "active" "roundtrip: reviewing → active (bounce back)"

# active → complete
mission_set_state "$_tf" "complete" "test" 2>/dev/null
assert_eq "$(mission_get_state "$_tf")" "complete" "roundtrip: active → complete (terminal)"

# Verify file integrity — state line present, title preserved
_content=$(cat "$_tf")
assert_contains "$_content" "# Round Trip Mission" "roundtrip: title preserved through transitions"
assert_contains "$_content" "## State: complete" "roundtrip: final state line correct"
assert_contains "$_content" "## Success Criteria" "roundtrip: criteria section preserved"

# ── 15. Round-trip: failure and re-plan path ────────────────────────

echo ""
log "=== Round-trip: failure → re-plan path ==="

_tf="$TMPDIR_ROOT/replan.md"
printf '# Re-plan Mission\n## State: active\n## Success Criteria\n- [ ] Goal\n' > "$_tf"

# active → failed
mission_set_state "$_tf" "failed" "test" 2>/dev/null
assert_eq "$(mission_get_state "$_tf")" "failed" "replan: active → failed"

# failed → draft (re-plan)
mission_set_state "$_tf" "draft" "test" 2>/dev/null
assert_eq "$(mission_get_state "$_tf")" "draft" "replan: failed → draft (re-plan)"

# draft → active (retry)
mission_set_state "$_tf" "active" "test" 2>/dev/null
assert_eq "$(mission_get_state "$_tf")" "active" "replan: draft → active (retry)"

# active → complete (success on second attempt)
mission_set_state "$_tf" "complete" "test" 2>/dev/null
assert_eq "$(mission_get_state "$_tf")" "complete" "replan: active → complete (success)"

# ── 16. Rapid state overwrites (last write wins) ───────────────────

echo ""
log "=== Rapid overwrites: state consistency ==="

_tf="$TMPDIR_ROOT/rapid.md"
printf '# Rapid Mission\n## State: draft\n' > "$_tf"

# Simulate rapid transitions
mission_set_state "$_tf" "active" "test" 2>/dev/null
mission_set_state "$_tf" "paused" "test" 2>/dev/null
mission_set_state "$_tf" "active" "test" 2>/dev/null
mission_set_state "$_tf" "reviewing" "test" 2>/dev/null
mission_set_state "$_tf" "complete" "test" 2>/dev/null

# Only one State: line should exist
_state_lines=$(grep -c '## State:' "$_tf")
assert_eq "$_state_lines" "1" "rapid: only one State: line after multiple transitions"
assert_eq "$(mission_get_state "$_tf")" "complete" "rapid: final state is complete"

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
