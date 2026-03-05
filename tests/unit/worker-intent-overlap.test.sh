#!/usr/bin/env bash
# tests/unit/worker-intent-overlap.test.sh — Unit tests for worker intent overlap
# detection: the claim-time check that prevents concurrent workers from touching
# overlapping code areas (file-level and directory-level conflicts via tag mapping).
#
# Tests: tag→code-area directory mapping, title→file-path keyword extraction,
#        overlap threshold (2+ shared keywords), and the full worker skip cycle.
#
# Usage: bash tests/unit/worker-intent-overlap.test.sh

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

assert_not_contains() {
  local haystack="$1" needle="$2" msg="$3"
  if printf '%s' "$haystack" | grep -qF "$needle"; then
    fail "$msg (should NOT contain '$needle')"
  else
    pass "$msg"
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

# Minimal config stubs required by _db.sh
export SKYNET_PROJECT_DIR="$TMPDIR_ROOT"
export SKYNET_DEV_DIR="$TMPDIR_ROOT/.dev"
export SKYNET_PROJECT_NAME="test-worker-overlap"
export SKYNET_LOCK_PREFIX="/tmp/skynet-test-worker-overlap"
export SKYNET_STALE_MINUTES=45
export SKYNET_MAX_WORKERS=4
export SKYNET_MAIN_BRANCH="main"

mkdir -p "$SKYNET_DEV_DIR"

# Suppress log during sourcing
log() { :; }

# Source _db.sh directly
source "$REPO_ROOT/scripts/_db.sh"

# Stub _generate_trace_id
_generate_trace_id() {
  printf '%s' "test-$$-$(date +%s)"
}

SEP=$'\x1f'

# Initialize DB
db_init

# Restore test log functions
log()  { printf "  %s\n" "$*"; }

echo "worker-intent-overlap.test.sh — unit tests for worker intent overlap detection"

# ============================================================
# TEST: Directory-level conflict detection via tag mapping
# Workers with the same tag share directory-level code areas,
# making overlap highly likely when titles also share nouns.
# ============================================================

echo ""
log "=== Directory-level conflicts: same tag ==="

sqlite3 "$DB_PATH" "DELETE FROM workers;"

# Two INFRA workers touching scripts/ — should overlap via shared "scripts" + "infra" dirs
db_set_worker_status 1 "dev" "in_progress" "" "Refactor config loader" "" 2>/dev/null || true
db_declare_intent 1 "INFRA" "Refactor config loader"

overlap=$(db_check_intent_overlap 2 "INFRA" "Update config validator")
# Both map to "scripts infra" from INFRA tag, and share "config" from title
assert_not_empty "$overlap" "dir-level: two INFRA workers sharing 'config' overlap (scripts+infra+config)"

# Two UI workers touching components/ — should overlap
sqlite3 "$DB_PATH" "DELETE FROM workers;"
db_set_worker_status 1 "dev" "in_progress" "" "Build status panel" "" 2>/dev/null || true
db_declare_intent 1 "UI" "Build status panel"

overlap=$(db_check_intent_overlap 2 "UI" "Fix status indicator")
# Both share "components" + "ui" from tag, and "status" from title = 3 keywords
assert_not_empty "$overlap" "dir-level: two UI workers sharing 'status' overlap (components+ui+status)"

# Two DATA workers touching handlers/ — should overlap
sqlite3 "$DB_PATH" "DELETE FROM workers;"
db_set_worker_status 1 "dev" "in_progress" "" "Create task endpoint" "" 2>/dev/null || true
db_declare_intent 1 "DATA" "Create task endpoint"

overlap=$(db_check_intent_overlap 2 "DATA" "Fix task validation")
# Both share "handlers" + "data" + "api" from tag, and "task" from title = 4 keywords
assert_not_empty "$overlap" "dir-level: two DATA workers sharing 'task' overlap (handlers+data+api+task)"

# ============================================================
# TEST: Directory-level no-conflict: different tags, different areas
# Workers in completely different code areas should NOT overlap
# even if they use some similar generic words.
# ============================================================

echo ""
log "=== Directory-level no-conflict: different tags ==="

sqlite3 "$DB_PATH" "DELETE FROM workers;"

# INFRA (scripts/) vs CLI (packages-cli/) — different dirs, different words
db_set_worker_status 1 "dev" "in_progress" "" "Add heartbeat monitor" "" 2>/dev/null || true
db_declare_intent 1 "INFRA" "Add heartbeat monitor"

overlap=$(db_check_intent_overlap 2 "CLI" "Build doctor command")
assert_empty "$overlap" "dir-no-conflict: INFRA vs CLI — no shared code areas"

# UI (components/) vs INFRA (scripts/) — no overlap
sqlite3 "$DB_PATH" "DELETE FROM workers;"
db_set_worker_status 1 "dev" "in_progress" "" "Add worker chart" "" 2>/dev/null || true
db_declare_intent 1 "UI" "Add worker chart"

overlap=$(db_check_intent_overlap 2 "INFRA" "Fix cron scheduler")
assert_empty "$overlap" "dir-no-conflict: UI vs INFRA — different code areas"

# ============================================================
# TEST: Cross-tag overlap via shared file-level keywords
# Different tags can still overlap if title nouns point at the
# same files (e.g., "handler" appears in both TEST and DATA areas).
# ============================================================

echo ""
log "=== Cross-tag file-level conflicts ==="

sqlite3 "$DB_PATH" "DELETE FROM workers;"

# TEST (test handlers) + DATA (handlers data api) — share "handlers"
# Plus same title noun "endpoint" → 2+ shared keywords
db_set_worker_status 1 "dev" "in_progress" "" "Validate endpoint response" "" 2>/dev/null || true
db_declare_intent 1 "TEST" "Validate endpoint response"

overlap=$(db_check_intent_overlap 2 "DATA" "Create endpoint handler")
# TEST intent: "test handlers validate endpoint response"
# DATA intent: "handlers data api create endpoint handler"
# Shared: "handlers", "endpoint" = 2+ keywords
assert_not_empty "$overlap" "cross-tag: TEST and DATA overlap via 'handlers' + 'endpoint'"

# DASHBOARD (dashboard components) + UI (components ui) — share "components"
sqlite3 "$DB_PATH" "DELETE FROM workers;"
db_set_worker_status 1 "dev" "in_progress" "" "Fix sidebar layout" "" 2>/dev/null || true
db_declare_intent 1 "DASHBOARD" "Fix sidebar layout"

overlap=$(db_check_intent_overlap 2 "UI" "Update sidebar styling")
# DASHBOARD intent: "dashboard components sidebar layout"
# UI intent: "components ui update sidebar styling"
# Shared: "components", "sidebar" = 2 keywords
assert_not_empty "$overlap" "cross-tag: DASHBOARD and UI overlap via 'components' + 'sidebar'"

# ============================================================
# TEST: Overlap threshold boundary — exactly 2 shared keywords
# ============================================================

echo ""
log "=== Threshold boundary: exactly 2 shared keywords ==="

sqlite3 "$DB_PATH" "DELETE FROM workers;"

# Craft intents that share exactly 2 keywords
# Worker 1: INFRA "Fix locks" → intent: "scripts infra fix locks"
db_set_worker_status 1 "dev" "in_progress" "" "Fix locks" "" 2>/dev/null || true
db_declare_intent 1 "INFRA" "Fix locks"

# Worker 2: INFRA "Improve retry" → intent: "scripts infra improve retry"
# Shared: "scripts" + "infra" = exactly 2 (from tag only, different title nouns)
overlap=$(db_check_intent_overlap 2 "INFRA" "Improve retry")
assert_not_empty "$overlap" "threshold: exactly 2 shared keywords (from tag) triggers overlap"

# ============================================================
# TEST: Overlap threshold boundary — exactly 1 shared keyword
# ============================================================

echo ""
log "=== Threshold boundary: exactly 1 shared keyword ==="

sqlite3 "$DB_PATH" "DELETE FROM workers;"

# INFRA (scripts infra) vs unknown tag "PERF" (perf) — only share nothing from tag
# But if title shares a word... let's be careful
db_set_worker_status 1 "dev" "in_progress" "" "Fix logging output" "" 2>/dev/null || true
db_declare_intent 1 "INFRA" "Fix logging output"
# Intent: "scripts infra fix logging output"

# Worker 2: unknown tag "PERF" → intent: "perf optimize logging"
# Shared: "logging" only = 1 keyword → should NOT overlap
overlap=$(db_check_intent_overlap 2 "PERF" "Optimize logging")
w1_intent=$(sqlite3 "$DB_PATH" "SELECT intent FROM workers WHERE id=1;")
w2_intent=$(_extract_intent "PERF" "Optimize logging")
shared=0
for word in $w2_intent; do
  case " $w1_intent " in
    *" $word "*) shared=$((shared + 1)) ;;
  esac
done
if [ "$shared" -lt 2 ]; then
  assert_empty "$overlap" "threshold: 1 shared keyword ($shared) does NOT trigger overlap"
else
  assert_not_empty "$overlap" "threshold: $shared shared keywords triggers overlap (unexpected)"
fi

# ============================================================
# TEST: Worker skip cycle — claim, detect overlap, unclaim, reclaim
# Simulates the dev-worker.sh flow: claim → intent declare →
# overlap check → unclaim → another worker reclaims.
# ============================================================

echo ""
log "=== Worker skip cycle: claim → overlap → unclaim → reclaim ==="

sqlite3 "$DB_PATH" "DELETE FROM tasks; DELETE FROM workers;"

# Worker 1 claims and starts an INFRA task
task1_id=$(db_add_task "Build pipeline dashboard" "INFRA" "" "top")
db_claim_next_task 1 >/dev/null
db_set_worker_status 1 "dev" "in_progress" "" "Build pipeline dashboard" "" 2>/dev/null || true
db_declare_intent 1 "INFRA" "Build pipeline dashboard"

# Worker 2 claims a conflicting task
task2_id=$(db_add_task "Fix pipeline scripts" "INFRA" "" "top")
result2=$(db_claim_next_task 2)
task2_claimed_id=$(echo "$result2" | cut -d"$SEP" -f1)

# Worker 2 checks for overlap
overlap=$(db_check_intent_overlap 2 "INFRA" "Fix pipeline scripts")
assert_not_empty "$overlap" "skip-cycle: worker 2 detects overlap with worker 1"

# Worker 2 skips: clear intent and unclaim
db_clear_intent 2
db_unclaim_task "$task2_claimed_id"
status_after=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$task2_claimed_id;")
assert_eq "$status_after" "pending" "skip-cycle: task reverts to pending after overlap skip"

# Worker 1 finishes and clears
db_clear_intent 1

# Worker 3 can now claim the unclaimed task without overlap
overlap3=$(db_check_intent_overlap 3 "INFRA" "Fix pipeline scripts")
assert_empty "$overlap3" "skip-cycle: no overlap after worker 1 cleared intent"

result3=$(db_claim_next_task 3)
task3_title=$(echo "$result3" | cut -d"$SEP" -f2)
assert_eq "$task3_title" "Fix pipeline scripts" "skip-cycle: worker 3 reclaims the skipped task"

# ============================================================
# TEST: Concurrent workers — 4 workers, only non-overlapping proceed
# ============================================================

echo ""
log "=== Concurrent workers: mixed overlap/no-overlap ==="

sqlite3 "$DB_PATH" "DELETE FROM tasks; DELETE FROM workers;"

# Worker 1: INFRA pipeline task (in_progress)
db_set_worker_status 1 "dev" "in_progress" "" "Add pipeline monitoring" "" 2>/dev/null || true
db_declare_intent 1 "INFRA" "Add pipeline monitoring"

# Worker 2: CLI task (no overlap with INFRA)
db_set_worker_status 2 "dev" "in_progress" "" "Build init command" "" 2>/dev/null || true
db_declare_intent 2 "CLI" "Build init command"

# Worker 3 tries INFRA pipeline task → should overlap with worker 1
overlap_w3=$(db_check_intent_overlap 3 "INFRA" "Fix pipeline config")
assert_not_empty "$overlap_w3" "concurrent: worker 3 overlaps with worker 1 (both INFRA pipeline)"
# Should NOT overlap with worker 2 (CLI)
assert_not_contains "$overlap_w3" "2|" "concurrent: worker 3 does not overlap with worker 2 (CLI)"

# Worker 4 tries UI task → should not overlap with any
overlap_w4=$(db_check_intent_overlap 4 "UI" "Build worker chart")
assert_empty "$overlap_w4" "concurrent: worker 4 (UI) no overlap with INFRA or CLI"

# ============================================================
# TEST: DASH* wildcard tag mapping — DASHBOARD, DASH-UI, DASH-DATA
# ============================================================

echo ""
log "=== DASH* wildcard tag mapping ==="

sqlite3 "$DB_PATH" "DELETE FROM workers;"

# DASHBOARD and DASH-UI should both map to "dashboard components"
db_set_worker_status 1 "dev" "in_progress" "" "Fix sidebar theme" "" 2>/dev/null || true
db_declare_intent 1 "DASHBOARD" "Fix sidebar theme"

overlap=$(db_check_intent_overlap 2 "DASH-UI" "Update sidebar colors")
# DASHBOARD intent: "dashboard components sidebar theme"
# DASH-UI intent: "dashboard components update sidebar colors"
# Shared: "dashboard", "components", "sidebar" = 3 keywords
assert_not_empty "$overlap" "dash-wildcard: DASHBOARD and DASH-UI share code area"

# ============================================================
# TEST: Empty tag and empty title edge cases
# ============================================================

echo ""
log "=== Edge cases: empty tag and title ==="

sqlite3 "$DB_PATH" "DELETE FROM workers;"

# Worker with empty tag gets tag lowercased to ""
result=$(_extract_intent "" "Some random task")
assert_not_empty "$result" "edge: empty tag still extracts title nouns"

# Worker with empty title only gets tag area
result=$(_extract_intent "INFRA" "")
assert_contains "$result" "scripts" "edge: empty title still maps tag to code area"
assert_contains "$result" "infra" "edge: empty title preserves tag keywords"

# Both workers with empty tags but shared title nouns
db_set_worker_status 1 "dev" "in_progress" "" "Build worker dashboard" "" 2>/dev/null || true
db_declare_intent 1 "" "Build worker dashboard"

overlap=$(db_check_intent_overlap 2 "" "Fix worker dashboard")
# Both have empty tag → intent from title only: "worker dashboard" shared
w1_intent=$(sqlite3 "$DB_PATH" "SELECT intent FROM workers WHERE id=1;")
w2_intent=$(_extract_intent "" "Fix worker dashboard")
shared=0
for word in $w2_intent; do
  [ -z "$word" ] && continue
  case " $w1_intent " in
    *" $word "*) shared=$((shared + 1)) ;;
  esac
done
if [ "$shared" -ge 2 ]; then
  assert_not_empty "$overlap" "edge: empty-tag workers overlap via shared title nouns ($shared shared)"
else
  assert_empty "$overlap" "edge: empty-tag workers with <2 shared nouns don't overlap"
fi

# ============================================================
# TEST: Special characters in task titles
# ============================================================

echo ""
log "=== Edge cases: special characters in titles ==="

sqlite3 "$DB_PATH" "DELETE FROM workers;"

# Titles with backticks, dots, hyphens
db_set_worker_status 1 "dev" "in_progress" "" "Fix \`_config.sh\` loader" "" 2>/dev/null || true
db_declare_intent 1 "INFRA" "Fix \`_config.sh\` loader"
w1_intent=$(sqlite3 "$DB_PATH" "SELECT intent FROM workers WHERE id=1;")
assert_not_empty "$w1_intent" "special-chars: intent stored with backtick title"

# Title with hyphens (e.g., "next-dev-server")
sqlite3 "$DB_PATH" "DELETE FROM workers;"
db_set_worker_status 1 "dev" "in_progress" "" "Fix next-dev-server startup" "" 2>/dev/null || true
db_declare_intent 1 "INFRA" "Fix next-dev-server startup"
w1_intent=$(sqlite3 "$DB_PATH" "SELECT intent FROM workers WHERE id=1;")
# Hyphens are converted to spaces by tr -cs, so "next-dev-server" becomes "next dev server"
assert_contains "$w1_intent" "next" "special-chars: hyphens split into separate words"
assert_contains "$w1_intent" "server" "special-chars: hyphens split — 'server' extracted"

# ============================================================
# TEST: Numeric words in titles (e.g., task IDs, port numbers)
# ============================================================

echo ""
log "=== Edge cases: numeric words in titles ==="

result=$(_extract_intent "INFRA" "Fix port 3100 binding")
assert_contains "$result" "3100" "numeric: port numbers preserved in intent"
assert_contains "$result" "port" "numeric: words alongside numbers preserved"
assert_contains "$result" "binding" "numeric: other nouns preserved"

# ============================================================
# TEST: Overlap output includes correct worker info
# ============================================================

echo ""
log "=== Output validation: overlap reports worker details ==="

sqlite3 "$DB_PATH" "DELETE FROM workers;"

db_set_worker_status 1 "dev" "in_progress" "" "Build pipeline health check" "" 2>/dev/null || true
db_declare_intent 1 "INFRA" "Build pipeline health check"

db_set_worker_status 2 "dev" "in_progress" "" "Add pipeline error handler" "" 2>/dev/null || true
db_declare_intent 2 "INFRA" "Add pipeline error handler"

# Worker 3 checks — should get both in output
overlap=$(db_check_intent_overlap 3 "INFRA" "Fix pipeline restart logic")
assert_not_empty "$overlap" "output: overlap detected with multiple workers"

# Verify output format per line: worker_id|intent|task_title
line_count=$(printf '%s\n' "$overlap" | grep -c '|' || true)
if [ "$line_count" -ge 2 ]; then
  pass "output: reports both overlapping workers ($line_count lines)"
else
  fail "output: expected 2+ overlapping workers (got $line_count lines)"
fi

# Parse first line
first_line=$(printf '%s\n' "$overlap" | head -1)
ov_wid=$(printf '%s' "$first_line" | cut -d'|' -f1)
ov_intent=$(printf '%s' "$first_line" | cut -d'|' -f2)
ov_title=$(printf '%s' "$first_line" | cut -d'|' -f3)

if [ "$ov_wid" = "1" ] || [ "$ov_wid" = "2" ]; then
  pass "output: worker_id is valid ($ov_wid)"
else
  fail "output: worker_id should be 1 or 2 (got '$ov_wid')"
fi
assert_not_empty "$ov_intent" "output: intent field populated"
assert_not_empty "$ov_title" "output: task_title field populated"

# ============================================================
# TEST: Rapid intent churn — declare/clear/declare cycle
# ============================================================

echo ""
log "=== Rapid intent churn ==="

sqlite3 "$DB_PATH" "DELETE FROM workers;"

db_set_worker_status 1 "dev" "in_progress" "" "Task A" "" 2>/dev/null || true

# Rapidly switch intents
db_declare_intent 1 "INFRA" "Task Alpha"
db_clear_intent 1
db_declare_intent 1 "DATA" "Task Beta"
db_clear_intent 1
db_declare_intent 1 "UI" "Build component library"

stored=$(sqlite3 "$DB_PATH" "SELECT intent FROM workers WHERE id=1;")
assert_contains "$stored" "components" "churn: final intent reflects last declaration (UI)"
assert_contains "$stored" "ui" "churn: final intent has UI tag area"
assert_contains "$stored" "component" "churn: final intent has title noun"

# Verify no stale data from prior intents
assert_not_contains "$stored" "scripts" "churn: no stale INFRA keywords"
assert_not_contains "$stored" "handlers" "churn: no stale DATA keywords"

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
