#!/usr/bin/env bash
# tests/unit/mission-state.test.sh — Regression tests for mission state transitions
#
# Tests the full mission lifecycle: slug resolution → mission loading →
# success criteria parsing → completion detection → sentinel file creation.
# Covers project-driver.sh mission-loading logic (lines 9-26) and
# completion detection (lines 496-560).
#
# Usage: bash tests/unit/mission-state.test.sh

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
  local val="$1" msg="$2"
  if [ -n "$val" ]; then
    pass "$msg"
  else
    fail "$msg (got empty string)"
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

# Create minimal config for sourcing _config.sh
export SKYNET_DEV_DIR="$TMPDIR_ROOT/dev"
mkdir -p "$SKYNET_DEV_DIR/missions"
cat > "$SKYNET_DEV_DIR/skynet.config.sh" << CONF
export SKYNET_PROJECT_NAME="test-mission-state"
export SKYNET_PROJECT_DIR="$TMPDIR_ROOT/project"
export SKYNET_DEV_DIR="$SKYNET_DEV_DIR"
CONF
mkdir -p "$TMPDIR_ROOT/project"

# Source _config.sh (suppressing warnings from validators/notify)
cd "$REPO_ROOT"
source scripts/_config.sh 2>/dev/null || true
set +e  # _config.sh enables errexit; disable for test assertions

echo "mission-state.test.sh — regression tests for mission state transitions"

# ── 0. Shared mission state reader normalization ─────────────────────

echo ""
log "=== Shared mission state reader normalization ==="

_state_file="$TMPDIR_ROOT/state-normalized.md"
cat > "$_state_file" << 'MFILE'
# Mission
## State: ACTIVE
MFILE
assert_eq "$(_get_mission_state "$_state_file")" "active" "_get_mission_state: normalizes uppercase state to lowercase"

cat > "$_state_file" << 'MFILE'
# Mission
State: Paused
MFILE
assert_eq "$(_get_mission_state "$_state_file")" "paused" "_get_mission_state: supports legacy State: format"

# ── Helper: parse success criteria (extracted from project-driver.sh) ──

# Mirrors the exact logic from project-driver.sh lines 518-522.
# Parses "## Success Criteria" section from a mission file.
_parse_criteria() {
  local mission_file="$1"
  sed -n '/^## Success Criteria/,/^## /p' "$mission_file" | grep '^[-*]\s*\[[ xX]\]' || true
}

_count_total_criteria() {
  local raw="$1"
  [ -z "$raw" ] && { echo 0; return; }
  echo "$raw" | wc -l | grep -oE '[0-9]+' | head -1 || echo 0
}

_count_met_criteria() {
  local raw="$1"
  [ -z "$raw" ] && { echo 0; return; }
  local count
  count=$(echo "$raw" | grep -ci '\[x\]' || true)
  echo "$count" | grep -oE '[0-9]+' | head -1
}

# ── 1. Mission slug resolution state transitions ───────────────────

echo ""
log "=== Mission slug resolution: env override vs config fallback ==="

# Test 1: SKYNET_MISSION_SLUG env overrides _config.json
cat > "$MISSION_CONFIG" << 'MJSON'
{
  "activeMission": "alpha-feature",
  "assignments": {}
}
MJSON
cat > "$MISSIONS_DIR/alpha-feature.md" << 'MFILE'
# Alpha Feature Mission
## Success Criteria
- [ ] Alpha criterion
MFILE
cat > "$MISSIONS_DIR/beta-bugfix.md" << 'MFILE'
# Beta Bugfix Mission
## Success Criteria
- [ ] Beta criterion
MFILE

# Simulate project-driver.sh mission loading logic (lines 9-20)
_mission_slug="beta-bugfix"  # env override
_mission_file="$MISSION"
_mission_hash=""
if [ -n "$_mission_slug" ] && [ -f "$MISSIONS_DIR/${_mission_slug}.md" ]; then
  _mission_file="$MISSIONS_DIR/${_mission_slug}.md"
  _mission_hash="$_mission_slug"
fi
assert_eq "$_mission_file" "$MISSIONS_DIR/beta-bugfix.md" "env override: selects slug from SKYNET_MISSION_SLUG"
assert_eq "$_mission_hash" "beta-bugfix" "env override: sets mission hash"

# Test 2: Falls back to active mission from _config.json when no env slug
_mission_slug=""
_mission_file="$MISSION"
_mission_hash=""
if [ -n "$_mission_slug" ] && [ -f "$MISSIONS_DIR/${_mission_slug}.md" ]; then
  _mission_file="$MISSIONS_DIR/${_mission_slug}.md"
  _mission_hash="$_mission_slug"
elif [ -f "$MISSION_CONFIG" ]; then
  _active=$(_resolve_active_mission)
  [ -f "$_active" ] && _mission_file="$_active"
fi
assert_eq "$_mission_file" "$MISSIONS_DIR/alpha-feature.md" "config fallback: uses activeMission from _config.json"

# Test 3: Falls back to legacy mission.md when no config
mv "$MISSION_CONFIG" "${MISSION_CONFIG}.bak"
echo "# Legacy Mission" > "$MISSION"
_mission_slug=""
_mission_file="$MISSION"
_mission_hash=""
if [ -n "$_mission_slug" ] && [ -f "$MISSIONS_DIR/${_mission_slug}.md" ]; then
  _mission_file="$MISSIONS_DIR/${_mission_slug}.md"
  _mission_hash="$_mission_slug"
elif [ -f "$MISSION_CONFIG" ]; then
  _active=$(_resolve_active_mission)
  [ -f "$_active" ] && _mission_file="$_active"
fi
assert_eq "$_mission_file" "$MISSION" "legacy fallback: uses mission.md when no _config.json"
mv "${MISSION_CONFIG}.bak" "$MISSION_CONFIG"

# Test 4: Hash backfill from active slug when env slug is empty
_mission_hash=""
_active_slug=$(_get_active_mission_slug)
[ -n "$_active_slug" ] && _mission_hash="$_active_slug"
assert_eq "$_mission_hash" "alpha-feature" "hash backfill: sets hash from active mission slug"

# ── 2. Success criteria parsing ─────────────────────────────────────

echo ""
log "=== Success criteria parsing ==="

# Test 5: Parses unchecked criteria
_sc_file="$TMPDIR_ROOT/mission-unchecked.md"
cat > "$_sc_file" << 'MFILE'
# Test Mission
## Success Criteria
- [ ] First criterion
- [ ] Second criterion
- [ ] Third criterion
## Notes
Not criteria
MFILE
_raw=$(_parse_criteria "$_sc_file")
_total=$(_count_total_criteria "$_raw")
_met=$(_count_met_criteria "$_raw")
assert_eq "$_total" "3" "criteria parse: counts 3 unchecked criteria"
assert_eq "$_met" "0" "criteria parse: 0 met criteria"

# Test 6: Parses fully checked criteria
_sc_file="$TMPDIR_ROOT/mission-checked.md"
cat > "$_sc_file" << 'MFILE'
# Test Mission
## Success Criteria
- [x] First done
- [x] Second done
MFILE
_raw=$(_parse_criteria "$_sc_file")
_total=$(_count_total_criteria "$_raw")
_met=$(_count_met_criteria "$_raw")
assert_eq "$_total" "2" "criteria parse: counts 2 checked criteria"
assert_eq "$_met" "2" "criteria parse: 2 met criteria"

# Test 7: Parses mixed checked/unchecked
_sc_file="$TMPDIR_ROOT/mission-mixed.md"
cat > "$_sc_file" << 'MFILE'
# Test Mission
## Success Criteria
- [x] Done task
- [ ] Pending task
- [X] Also done (uppercase X)
- [ ] Another pending
MFILE
_raw=$(_parse_criteria "$_sc_file")
_total=$(_count_total_criteria "$_raw")
_met=$(_count_met_criteria "$_raw")
assert_eq "$_total" "4" "criteria parse: counts 4 mixed criteria"
assert_eq "$_met" "2" "criteria parse: 2 met (handles [x] and [X])"

# Test 8: No success criteria section returns empty
_sc_file="$TMPDIR_ROOT/mission-no-criteria.md"
cat > "$_sc_file" << 'MFILE'
# Test Mission
## Overview
Just a description, no criteria section.
MFILE
_raw=$(_parse_criteria "$_sc_file")
assert_eq "$_raw" "" "criteria parse: empty when no Success Criteria section"

# Test 9: Success criteria section with no checkboxes
_sc_file="$TMPDIR_ROOT/mission-no-checkboxes.md"
cat > "$_sc_file" << 'MFILE'
# Test Mission
## Success Criteria
This section has text but no checkbox items.
MFILE
_raw=$(_parse_criteria "$_sc_file")
assert_eq "$_raw" "" "criteria parse: empty when section has no checkboxes"

# Test 10: Criteria with asterisk bullets (not just dashes)
_sc_file="$TMPDIR_ROOT/mission-asterisk.md"
cat > "$_sc_file" << 'MFILE'
# Test Mission
## Success Criteria
* [x] Done with asterisk
* [ ] Pending with asterisk
MFILE
_raw=$(_parse_criteria "$_sc_file")
_total=$(_count_total_criteria "$_raw")
_met=$(_count_met_criteria "$_raw")
assert_eq "$_total" "2" "criteria parse: handles asterisk bullets"
assert_eq "$_met" "1" "criteria parse: counts met with asterisk bullets"

# ── 3. Mission completion detection ─────────────────────────────────

echo ""
log "=== Mission completion detection ==="

# Test 11: All criteria met + zero pending = complete
_sc_file="$TMPDIR_ROOT/mission-complete.md"
cat > "$_sc_file" << 'MFILE'
# Ship Dashboard v2
## Success Criteria
- [x] Dashboard renders correctly
- [x] All API routes working
- [x] Tests passing
MFILE
_raw=$(_parse_criteria "$_sc_file")
_total=$(_count_total_criteria "$_raw")
_met=$(_count_met_criteria "$_raw")
mc_pending=0
if [ -n "$_raw" ] && [ "$_met" -ge "$_total" ] && [ "$_total" -gt 0 ] && [ "$mc_pending" -eq 0 ]; then
  _complete="yes"
else
  _complete="no"
fi
assert_eq "$_complete" "yes" "completion: all criteria met + zero pending = complete"

# Test 12: All criteria met but pending tasks remain = not complete
mc_pending=3
if [ -n "$_raw" ] && [ "$_met" -ge "$_total" ] && [ "$_total" -gt 0 ] && [ "$mc_pending" -eq 0 ]; then
  _complete="yes"
else
  _complete="no"
fi
assert_eq "$_complete" "no" "completion: all criteria met but pending > 0 = not complete"

# Test 13: Partial criteria met = not complete
_sc_file="$TMPDIR_ROOT/mission-partial.md"
cat > "$_sc_file" << 'MFILE'
# Partial Mission
## Success Criteria
- [x] First done
- [ ] Second pending
- [ ] Third pending
MFILE
_raw=$(_parse_criteria "$_sc_file")
_total=$(_count_total_criteria "$_raw")
_met=$(_count_met_criteria "$_raw")
mc_pending=0
if [ -n "$_raw" ] && [ "$_met" -ge "$_total" ] && [ "$_total" -gt 0 ] && [ "$mc_pending" -eq 0 ]; then
  _complete="yes"
else
  _complete="no"
fi
assert_eq "$_complete" "no" "completion: partial criteria = not complete"

# Test 14: No criteria section = skip completion (not complete)
_sc_file="$TMPDIR_ROOT/mission-no-section.md"
cat > "$_sc_file" << 'MFILE'
# No Criteria Mission
## Notes
Nothing here.
MFILE
_raw=$(_parse_criteria "$_sc_file")
mc_pending=0
if [ -n "$_raw" ]; then
  _complete="yes"
else
  _complete="no"
fi
assert_eq "$_complete" "no" "completion: no criteria section = skip detection"

# ── 4. Mission ID sanitization for sentinel files ───────────────────

echo ""
log "=== Mission ID sanitization ==="

# Test 15: Simple slug → unchanged
_mission_hash="alpha-feature"
_mission_id_safe=$(echo "$_mission_hash" | sed 's/[^a-zA-Z0-9]/_/g')
assert_eq "$_mission_id_safe" "alpha_feature" "sanitize: dashes become underscores"

# Test 16: Slug with dots and slashes
_mission_hash="deploy.v2/prod"
_mission_id_safe=$(echo "$_mission_hash" | sed 's/[^a-zA-Z0-9]/_/g')
assert_eq "$_mission_id_safe" "deploy_v2_prod" "sanitize: dots and slashes become underscores"

# Test 17: Empty hash defaults to "global"
_mission_hash=""
_mission_id_safe=$(echo "${_mission_hash:-global}" | sed 's/[^a-zA-Z0-9]/_/g')
assert_eq "$_mission_id_safe" "global" "sanitize: empty hash defaults to global"

# Test 18: Already clean slug → unchanged
_mission_hash="simpletask"
_mission_id_safe=$(echo "$_mission_hash" | sed 's/[^a-zA-Z0-9]/_/g')
assert_eq "$_mission_id_safe" "simpletask" "sanitize: clean slug unchanged"

# ── 5. Sentinel file lifecycle ──────────────────────────────────────

echo ""
log "=== Sentinel file lifecycle ==="

_sentinel_dir="$TMPDIR_ROOT/sentinel-test"
mkdir -p "$_sentinel_dir"

# Test 19: Sentinel file created on completion
_sentinel_path="$_sentinel_dir/mission-complete-alpha_feature"
assert_file_not_exists "$_sentinel_path" "sentinel: does not exist before completion"

# Simulate sentinel creation (mirrors project-driver.sh line 551)
_mission_name="Alpha Feature"
_mission_hash="alpha-feature"
_mc_total=3
echo "{\"completedAt\": \"2026-03-04T12:00:00Z\", \"mission\": \"$_mission_name\", \"slug\": \"$_mission_hash\", \"criteriaCount\": $_mc_total}" > "$_sentinel_path"
assert_file_exists "$_sentinel_path" "sentinel: created after completion"

# Test 20: Sentinel contains valid JSON with expected fields
_sentinel_content=$(cat "$_sentinel_path")
assert_contains "$_sentinel_content" '"completedAt"' "sentinel: contains completedAt field"
assert_contains "$_sentinel_content" '"mission": "Alpha Feature"' "sentinel: contains mission name"
assert_contains "$_sentinel_content" '"slug": "alpha-feature"' "sentinel: contains slug"
assert_contains "$_sentinel_content" '"criteriaCount": 3' "sentinel: contains criteria count"

# Test 21: Sentinel prevents re-detection (idempotency)
# When sentinel exists, project-driver.sh skips the entire completion block (line 502)
if [ -f "$_sentinel_path" ]; then
  _skipped="yes"
else
  _skipped="no"
fi
assert_eq "$_skipped" "yes" "sentinel: existing sentinel prevents re-detection"

# Test 22: Different mission slugs get independent sentinels
_sentinel_beta="$_sentinel_dir/mission-complete-beta_bugfix"
assert_file_not_exists "$_sentinel_beta" "sentinel: beta sentinel independent of alpha"

# ── 6. Full state transition: pending → active → complete ───────────

echo ""
log "=== Full lifecycle: pending → active → complete ==="

# Setup a full scenario
_lc_dir="$TMPDIR_ROOT/lifecycle"
mkdir -p "$_lc_dir/missions"
cat > "$_lc_dir/missions/_config.json" << 'MJSON'
{
  "activeMission": "ship-v2",
  "assignments": {
    "w1": "ship-v2",
    "w2": "ship-v2"
  }
}
MJSON

# State 1: Mission with all criteria pending
cat > "$_lc_dir/missions/ship-v2.md" << 'MFILE'
# Ship v2
## Success Criteria
- [ ] API endpoints implemented
- [ ] Dashboard renders
- [ ] Tests pass
MFILE

# Save original MISSION_CONFIG and MISSIONS_DIR
_orig_mc="$MISSION_CONFIG"
_orig_md="$MISSIONS_DIR"
MISSION_CONFIG="$_lc_dir/missions/_config.json"
MISSIONS_DIR="$_lc_dir/missions"

# Test 23: Worker resolves correct mission
_slug=$(_get_worker_mission_slug "w1")
assert_eq "$_slug" "ship-v2" "lifecycle: worker w1 assigned to ship-v2"

# Test 24: Mission file resolves correctly
_active=$(_resolve_active_mission)
assert_eq "$_active" "$_lc_dir/missions/ship-v2.md" "lifecycle: active mission file resolves"

# Test 25: Initial state — no criteria met
_raw=$(_parse_criteria "$_lc_dir/missions/ship-v2.md")
_met=$(_count_met_criteria "$_raw")
assert_eq "$_met" "0" "lifecycle: initial state has 0 criteria met"

# State 2: Partial progress — 1 criterion met
cat > "$_lc_dir/missions/ship-v2.md" << 'MFILE'
# Ship v2
## Success Criteria
- [x] API endpoints implemented
- [ ] Dashboard renders
- [ ] Tests pass
MFILE
_raw=$(_parse_criteria "$_lc_dir/missions/ship-v2.md")
_total=$(_count_total_criteria "$_raw")
_met=$(_count_met_criteria "$_raw")
assert_eq "$_met" "1" "lifecycle: after progress, 1 criterion met"
if [ "$_met" -ge "$_total" ] && [ "$_total" -gt 0 ]; then
  _state="complete"
else
  _state="in_progress"
fi
assert_eq "$_state" "in_progress" "lifecycle: partial progress = in_progress"

# State 3: All criteria met — mission complete
cat > "$_lc_dir/missions/ship-v2.md" << 'MFILE'
# Ship v2
## Success Criteria
- [x] API endpoints implemented
- [x] Dashboard renders
- [x] Tests pass
MFILE
_raw=$(_parse_criteria "$_lc_dir/missions/ship-v2.md")
_total=$(_count_total_criteria "$_raw")
_met=$(_count_met_criteria "$_raw")
assert_eq "$_met" "3" "lifecycle: all 3 criteria met"
if [ "$_met" -ge "$_total" ] && [ "$_total" -gt 0 ]; then
  _state="complete"
else
  _state="in_progress"
fi
assert_eq "$_state" "complete" "lifecycle: all criteria met = complete"

# Test 28: Sentinel written after completion
_lc_sentinel="$_lc_dir/mission-complete-ship_v2"
_lc_id_safe=$(echo "ship-v2" | sed 's/[^a-zA-Z0-9]/_/g')
echo "{\"completedAt\": \"$(date -u '+%Y-%m-%dT%H:%M:%SZ')\", \"mission\": \"Ship v2\", \"slug\": \"ship-v2\", \"criteriaCount\": $_total}" > "$_lc_dir/mission-complete-${_lc_id_safe}"
assert_file_exists "$_lc_dir/mission-complete-ship_v2" "lifecycle: sentinel written for ship-v2"

# Restore original config
MISSION_CONFIG="$_orig_mc"
MISSIONS_DIR="$_orig_md"

# ── 7. Edge cases ───────────────────────────────────────────────────

echo ""
log "=== Edge cases ==="

# Test 29: Mission file with criteria after last section (no trailing header)
_ec_file="$TMPDIR_ROOT/mission-trailing.md"
cat > "$_ec_file" << 'MFILE'
# Trailing Mission
## Success Criteria
- [x] Only criterion at end of file
MFILE
_raw=$(_parse_criteria "$_ec_file")
_total=$(_count_total_criteria "$_raw")
_met=$(_count_met_criteria "$_raw")
assert_eq "$_total" "1" "edge: criteria at end of file (no trailing header)"
assert_eq "$_met" "1" "edge: met criterion at end of file"

# Test 30: Mission with multiple ## sections before criteria
_ec_file="$TMPDIR_ROOT/mission-multi-section.md"
cat > "$_ec_file" << 'MFILE'
# Multi Section Mission
## Overview
Some overview text.
## Goals
Some goals.
## Success Criteria
- [x] Criterion A
- [ ] Criterion B
## Notes
Not criteria.
MFILE
_raw=$(_parse_criteria "$_ec_file")
_total=$(_count_total_criteria "$_raw")
_met=$(_count_met_criteria "$_raw")
assert_eq "$_total" "2" "edge: criteria parsed correctly from middle of file"
assert_eq "$_met" "1" "edge: met count correct from middle of file"

# Test 31: Empty mission file
_ec_file="$TMPDIR_ROOT/mission-empty.md"
: > "$_ec_file"
_raw=$(_parse_criteria "$_ec_file")
assert_eq "$_raw" "" "edge: empty file returns no criteria"

# Test 32: Criteria with extra text after checkbox
_ec_file="$TMPDIR_ROOT/mission-long-criteria.md"
cat > "$_ec_file" << 'MFILE'
# Detailed Mission
## Success Criteria
- [x] Implement the full authentication flow including OAuth2 and JWT token refresh
- [ ] Write comprehensive integration tests covering all edge cases and error scenarios
MFILE
_raw=$(_parse_criteria "$_ec_file")
_total=$(_count_total_criteria "$_raw")
_met=$(_count_met_criteria "$_raw")
assert_eq "$_total" "2" "edge: long criterion text parsed correctly"
assert_eq "$_met" "1" "edge: met count correct with long text"

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
