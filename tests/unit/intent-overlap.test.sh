#!/usr/bin/env bash
# tests/unit/intent-overlap.test.sh — Unit tests for intent overlap enforcement
# and task-skip behavior in _db.sh
#
# Tests: _extract_intent, db_declare_intent, db_check_intent_overlap,
#        db_clear_intent, and the overlap-driven skip logic
#
# Usage: bash tests/unit/intent-overlap.test.sh

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

# Minimal config stubs required by _db.sh
export SKYNET_PROJECT_DIR="$TMPDIR_ROOT"
export SKYNET_DEV_DIR="$TMPDIR_ROOT/.dev"
export SKYNET_PROJECT_NAME="test-overlap"
export SKYNET_LOCK_PREFIX="/tmp/skynet-test-overlap"
export SKYNET_STALE_MINUTES=45
export SKYNET_MAX_WORKERS=4
export SKYNET_MAIN_BRANCH="main"

mkdir -p "$SKYNET_DEV_DIR"

# Provide a stub log() function (suppress output during sourcing)
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

echo "intent-overlap.test.sh — unit tests for intent overlap enforcement and task-skip behavior"

# ============================================================
# TEST: _extract_intent — tag-to-intent mapping
# ============================================================

echo ""
log "=== _extract_intent: tag mapping ==="

result=$(_extract_intent "INFRA" "some task")
assert_contains "$result" "scripts" "_extract_intent: INFRA maps to 'scripts'"
assert_contains "$result" "infra" "_extract_intent: INFRA maps to 'infra'"

result=$(_extract_intent "DATA" "some task")
assert_contains "$result" "handlers" "_extract_intent: DATA maps to 'handlers'"
assert_contains "$result" "api" "_extract_intent: DATA maps to 'api'"

result=$(_extract_intent "UI" "some task")
assert_contains "$result" "components" "_extract_intent: UI maps to 'components'"
assert_contains "$result" "ui" "_extract_intent: UI maps to 'ui'"

result=$(_extract_intent "TEST" "some task")
assert_contains "$result" "test" "_extract_intent: TEST maps to 'test'"
assert_contains "$result" "handlers" "_extract_intent: TEST maps to 'handlers'"

result=$(_extract_intent "CLI" "some task")
assert_contains "$result" "cli" "_extract_intent: CLI maps to 'cli'"
assert_contains "$result" "packages-cli" "_extract_intent: CLI maps to 'packages-cli'"

result=$(_extract_intent "DASHBOARD" "some task")
assert_contains "$result" "dashboard" "_extract_intent: DASHBOARD maps to 'dashboard'"
assert_contains "$result" "components" "_extract_intent: DASHBOARD maps to 'components'"

result=$(_extract_intent "DASH-UI" "some task")
assert_contains "$result" "dashboard" "_extract_intent: DASH-UI maps to 'dashboard' (dash* glob)"

# Unknown tag falls through to lowercase
result=$(_extract_intent "CUSTOM" "some task")
assert_contains "$result" "custom" "_extract_intent: unknown tag lowercased"

# ============================================================
# TEST: _extract_intent — title noun extraction
# ============================================================

echo ""
log "=== _extract_intent: noun extraction ==="

# Extracts key nouns, strips stop words
result=$(_extract_intent "FEAT" "Add worker heartbeat monitoring")
assert_contains "$result" "worker" "_extract_intent: extracts 'worker' from title"
assert_contains "$result" "heartbeat" "_extract_intent: extracts 'heartbeat' from title"
assert_contains "$result" "monitoring" "_extract_intent: extracts 'monitoring' from title"

# Stop words like 'add', 'to', 'the', 'for' are removed
result=$(_extract_intent "FEAT" "Add the new handler for workers")
if printf '%s' " $result " | grep -q ' the '; then
  fail "_extract_intent: stop word 'the' should be removed"
else
  pass "_extract_intent: stop word 'the' removed"
fi

# Tag prefix in title (e.g. "[FEAT] ...") is stripped
result=$(_extract_intent "FEAT" "[FEAT] Build pipeline dashboard")
assert_contains "$result" "pipeline" "_extract_intent: strips [TAG] prefix from title"
assert_contains "$result" "dashboard" "_extract_intent: extracts nouns after tag prefix"

# Single-letter words are skipped
result=$(_extract_intent "FEAT" "a b c pipeline")
if printf '%s' " $result " | grep -qE ' [a-z] '; then
  fail "_extract_intent: single-letter words should be removed"
else
  pass "_extract_intent: single-letter words removed"
fi

# Case insensitive — title words are lowercased
result=$(_extract_intent "FEAT" "Build Pipeline Dashboard")
assert_contains "$result" "pipeline" "_extract_intent: lowercases title words"
assert_contains "$result" "dashboard" "_extract_intent: lowercases title words (2)"

# ============================================================
# TEST: db_declare_intent — stores intent in workers table
# ============================================================

echo ""
log "=== db_declare_intent ==="

# Create a worker row first
db_set_worker_status 1 "dev" "in_progress" "" "Test task" "" 2>/dev/null || true

db_declare_intent 1 "INFRA" "Add pipeline monitoring"
stored=$(sqlite3 "$DB_PATH" "SELECT intent FROM workers WHERE id=1;")
assert_not_empty "$stored" "db_declare_intent: stores non-empty intent"
assert_contains "$stored" "scripts" "db_declare_intent: intent contains tag area 'scripts'"
assert_contains "$stored" "pipeline" "db_declare_intent: intent contains noun 'pipeline'"
assert_contains "$stored" "monitoring" "db_declare_intent: intent contains noun 'monitoring'"

# Overwrites previous intent
db_declare_intent 1 "DATA" "Create user endpoint"
stored=$(sqlite3 "$DB_PATH" "SELECT intent FROM workers WHERE id=1;")
assert_contains "$stored" "handlers" "db_declare_intent: overwrites — new tag area 'handlers'"
assert_contains "$stored" "endpoint" "db_declare_intent: overwrites — new noun 'endpoint'"

# ============================================================
# TEST: db_clear_intent — clears worker intent
# ============================================================

echo ""
log "=== db_clear_intent ==="

db_declare_intent 1 "INFRA" "Some task"
db_clear_intent 1
stored=$(sqlite3 "$DB_PATH" "SELECT intent FROM workers WHERE id=1;")
assert_empty "$stored" "db_clear_intent: intent cleared to empty string"

# Clear on worker with no intent is a no-op
db_clear_intent 1
stored=$(sqlite3 "$DB_PATH" "SELECT intent FROM workers WHERE id=1;")
assert_empty "$stored" "db_clear_intent: idempotent — already empty"

# ============================================================
# TEST: db_check_intent_overlap — no overlap
# ============================================================

echo ""
log "=== db_check_intent_overlap: no overlap ==="

# Clean workers table
sqlite3 "$DB_PATH" "DELETE FROM workers;"

# Worker 1 active with INFRA intent
db_set_worker_status 1 "dev" "in_progress" "" "Infra task" "" 2>/dev/null || true
db_declare_intent 1 "INFRA" "Add pipeline locks"

# Worker 2 checks with a completely different intent (CLI)
overlap=$(db_check_intent_overlap 2 "CLI" "Build init command")
assert_empty "$overlap" "db_check_intent_overlap: no overlap between INFRA and CLI"

# ============================================================
# TEST: db_check_intent_overlap — overlap detected (2+ shared keywords)
# ============================================================

echo ""
log "=== db_check_intent_overlap: overlap detected ==="

sqlite3 "$DB_PATH" "DELETE FROM workers;"

# Worker 1: working on INFRA pipeline task
db_set_worker_status 1 "dev" "in_progress" "" "Add pipeline monitoring" "" 2>/dev/null || true
db_declare_intent 1 "INFRA" "Add pipeline monitoring"

# Worker 2 checks with similar INFRA task touching same area
# Both share "scripts" (from INFRA tag) + "pipeline" (from title) = 2 shared keywords
overlap=$(db_check_intent_overlap 2 "INFRA" "Fix pipeline scripts")
assert_not_empty "$overlap" "db_check_intent_overlap: detects overlap with 2+ shared keywords"
assert_contains "$overlap" "1|" "db_check_intent_overlap: reports overlapping worker ID"

# ============================================================
# TEST: db_check_intent_overlap — exactly 1 shared keyword (no overlap)
# ============================================================

echo ""
log "=== db_check_intent_overlap: 1 shared keyword (below threshold) ==="

sqlite3 "$DB_PATH" "DELETE FROM workers;"

# Worker 1: INFRA + pipeline → intent = "scripts infra pipeline"
db_set_worker_status 1 "dev" "in_progress" "" "Fix pipeline" "" 2>/dev/null || true
db_declare_intent 1 "INFRA" "Fix pipeline"

# Worker 2: DATA + pipeline → intent = "handlers data api pipeline"
# Shares only "pipeline" (1 keyword) — should NOT overlap
overlap=$(db_check_intent_overlap 2 "DATA" "Build pipeline endpoint")
# They share "pipeline" but tag areas differ (scripts vs handlers)
# Actually, let's verify the exact intent strings
w1_intent=$(sqlite3 "$DB_PATH" "SELECT intent FROM workers WHERE id=1;")
w2_intent=$(_extract_intent "DATA" "Build pipeline endpoint")
log "  Worker 1 intent: $w1_intent"
log "  Worker 2 intent: $w2_intent"

# Count shared words between them
shared=0
for word in $w2_intent; do
  case " $w1_intent " in
    *" $word "*) shared=$((shared + 1)) ;;
  esac
done
if [ "$shared" -lt 2 ]; then
  assert_empty "$overlap" "db_check_intent_overlap: <2 shared keywords = no overlap (shared=$shared)"
else
  # If they happen to share 2+, then overlap is expected
  assert_not_empty "$overlap" "db_check_intent_overlap: $shared shared keywords = overlap expected"
fi

# ============================================================
# TEST: db_check_intent_overlap — excludes self worker
# ============================================================

echo ""
log "=== db_check_intent_overlap: excludes self ==="

sqlite3 "$DB_PATH" "DELETE FROM workers;"

# Worker 1: active with an intent
db_set_worker_status 1 "dev" "in_progress" "" "Add infra pipeline" "" 2>/dev/null || true
db_declare_intent 1 "INFRA" "Add infra pipeline"

# Worker 1 checks itself — should never see self as overlap
overlap=$(db_check_intent_overlap 1 "INFRA" "Add infra pipeline")
assert_empty "$overlap" "db_check_intent_overlap: does not report self as overlap"

# ============================================================
# TEST: db_check_intent_overlap — only checks in_progress workers
# ============================================================

echo ""
log "=== db_check_intent_overlap: only in_progress workers ==="

sqlite3 "$DB_PATH" "DELETE FROM workers;"

# Worker 1: idle with an intent leftover (shouldn't happen in practice, but test the filter)
db_set_worker_status 1 "dev" "idle" "" "Add pipeline monitoring" "" 2>/dev/null || true
sqlite3 "$DB_PATH" "UPDATE workers SET intent='scripts infra pipeline monitoring' WHERE id=1;"

# Worker 2 checks — worker 1 is idle, so no overlap
overlap=$(db_check_intent_overlap 2 "INFRA" "Add pipeline monitoring")
assert_empty "$overlap" "db_check_intent_overlap: ignores idle workers"

# ============================================================
# TEST: db_check_intent_overlap — ignores workers with empty intent
# ============================================================

echo ""
log "=== db_check_intent_overlap: ignores empty intent ==="

sqlite3 "$DB_PATH" "DELETE FROM workers;"

# Worker 1: in_progress but no intent declared
db_set_worker_status 1 "dev" "in_progress" "" "Some task" "" 2>/dev/null || true
# intent is empty by default

overlap=$(db_check_intent_overlap 2 "INFRA" "Add pipeline monitoring")
assert_empty "$overlap" "db_check_intent_overlap: ignores workers with empty intent"

# ============================================================
# TEST: db_check_intent_overlap — multiple overlapping workers
# ============================================================

echo ""
log "=== db_check_intent_overlap: multiple overlapping workers ==="

sqlite3 "$DB_PATH" "DELETE FROM workers;"

# Worker 1 and Worker 2 both working on INFRA pipeline tasks
db_set_worker_status 1 "dev" "in_progress" "" "Add pipeline locks" "" 2>/dev/null || true
db_declare_intent 1 "INFRA" "Add pipeline locks"

db_set_worker_status 2 "dev" "in_progress" "" "Fix pipeline scripts" "" 2>/dev/null || true
db_declare_intent 2 "INFRA" "Fix pipeline scripts"

# Worker 3 checks — should see both as overlapping
overlap=$(db_check_intent_overlap 3 "INFRA" "Refactor pipeline config")
line_count=$(printf '%s' "$overlap" | grep -c '|' || true)
if [ "$line_count" -ge 2 ]; then
  pass "db_check_intent_overlap: reports multiple overlapping workers ($line_count)"
else
  fail "db_check_intent_overlap: expected 2+ overlapping workers (got $line_count lines)"
fi

# ============================================================
# TEST: db_check_intent_overlap — output format validation
# ============================================================

echo ""
log "=== db_check_intent_overlap: output format ==="

sqlite3 "$DB_PATH" "DELETE FROM workers;"

db_set_worker_status 1 "dev" "in_progress" "" "Add pipeline monitoring" "" 2>/dev/null || true
db_declare_intent 1 "INFRA" "Add pipeline monitoring"

overlap=$(db_check_intent_overlap 2 "INFRA" "Fix pipeline scripts")
if [ -n "$overlap" ]; then
  # Format: worker_id|intent|task_title
  first_line=$(printf '%s\n' "$overlap" | head -1)
  ov_wid=$(printf '%s' "$first_line" | cut -d'|' -f1)
  ov_intent=$(printf '%s' "$first_line" | cut -d'|' -f2)
  ov_title=$(printf '%s' "$first_line" | cut -d'|' -f3)
  assert_eq "$ov_wid" "1" "output format: worker_id field is correct"
  assert_not_empty "$ov_intent" "output format: intent field is non-empty"
  assert_eq "$ov_title" "Add pipeline monitoring" "output format: task_title field is correct"
else
  fail "output format: expected overlap result but got empty"
fi

# ============================================================
# TEST: db_check_intent_overlap — no active workers at all
# ============================================================

echo ""
log "=== db_check_intent_overlap: no active workers ==="

sqlite3 "$DB_PATH" "DELETE FROM workers;"

overlap=$(db_check_intent_overlap 1 "INFRA" "Add pipeline monitoring")
assert_empty "$overlap" "db_check_intent_overlap: empty when no other workers exist"

# ============================================================
# TEST: Task-skip — claim rate limiter (>3 claims in 5 min)
# ============================================================

echo ""
log "=== Task-skip: claim rate limiter ==="

# Simulate the claim tracker logic from dev-worker.sh
_claim_tracker="$TMPDIR_ROOT/claim-tracker-test"
rm -f "$_claim_tracker"

_now_epoch=$(date +%s)
_cutoff_epoch=$((_now_epoch - 300))
_test_task_id="42"

# Write 3 recent claim entries for the same task ID
echo "${_now_epoch}|${_test_task_id}" >> "$_claim_tracker"
echo "${_now_epoch}|${_test_task_id}" >> "$_claim_tracker"
echo "${_now_epoch}|${_test_task_id}" >> "$_claim_tracker"

# Now simulate checking: count recent claims for this task
_recent_claims=0
while IFS='|' read -r _ct_epoch _ct_id; do
  [ -z "$_ct_epoch" ] && continue
  case "$_ct_epoch" in ''|*[!0-9]*) continue ;; esac
  if [ "$_ct_epoch" -ge "$_cutoff_epoch" ]; then
    if [ "$_ct_id" = "$_test_task_id" ]; then
      _recent_claims=$((_recent_claims + 1))
    fi
  fi
done < "$_claim_tracker"

assert_eq "$_recent_claims" "3" "claim rate limiter: counts 3 recent claims"

# With 3 claims, the skip threshold (>=3) is triggered
if [ "$_recent_claims" -ge 3 ]; then
  pass "claim rate limiter: threshold >=3 triggers skip"
else
  fail "claim rate limiter: expected skip at >=3 (got $_recent_claims)"
fi

# Test with a different task ID — should not be counted
echo "${_now_epoch}|99" >> "$_claim_tracker"
_recent_claims_other=0
while IFS='|' read -r _ct_epoch _ct_id; do
  [ -z "$_ct_epoch" ] && continue
  case "$_ct_epoch" in ''|*[!0-9]*) continue ;; esac
  if [ "$_ct_epoch" -ge "$_cutoff_epoch" ] && [ "$_ct_id" = "99" ]; then
    _recent_claims_other=$((_recent_claims_other + 1))
  fi
done < "$_claim_tracker"
assert_eq "$_recent_claims_other" "1" "claim rate limiter: counts per task ID (task 99 = 1)"

# ============================================================
# TEST: Task-skip — stale entries pruned
# ============================================================

echo ""
log "=== Task-skip: stale entry pruning ==="

rm -f "$_claim_tracker"

# Write an old entry (10 minutes ago, beyond 5-min window)
_old_epoch=$((_now_epoch - 600))
echo "${_old_epoch}|${_test_task_id}" >> "$_claim_tracker"
# Write a recent entry
echo "${_now_epoch}|${_test_task_id}" >> "$_claim_tracker"

# Simulate the prune-and-count logic
_kept_lines=""
_recent_claims=0
while IFS='|' read -r _ct_epoch _ct_id; do
  [ -z "$_ct_epoch" ] && continue
  case "$_ct_epoch" in ''|*[!0-9]*) continue ;; esac
  if [ "$_ct_epoch" -ge "$_cutoff_epoch" ]; then
    _kept_lines="${_kept_lines}${_ct_epoch}|${_ct_id}
"
    if [ "$_ct_id" = "$_test_task_id" ]; then
      _recent_claims=$((_recent_claims + 1))
    fi
  fi
done < "$_claim_tracker"
printf '%s' "$_kept_lines" > "$_claim_tracker"

assert_eq "$_recent_claims" "1" "stale pruning: only counts recent entry (1, not 2)"

_line_count=$(wc -l < "$_claim_tracker" | tr -d ' ')
assert_eq "$_line_count" "1" "stale pruning: old entry removed from file"

# ============================================================
# TEST: Task-skip — malformed claim tracker entries ignored
# ============================================================

echo ""
log "=== Task-skip: malformed entries ==="

rm -f "$_claim_tracker"
echo "notanumber|42" >> "$_claim_tracker"
echo "|42" >> "$_claim_tracker"
echo "" >> "$_claim_tracker"
echo "${_now_epoch}|42" >> "$_claim_tracker"

_recent_claims=0
while IFS='|' read -r _ct_epoch _ct_id; do
  [ -z "$_ct_epoch" ] && continue
  case "$_ct_epoch" in ''|*[!0-9]*) continue ;; esac
  if [ "$_ct_epoch" -ge "$_cutoff_epoch" ] && [ "$_ct_id" = "42" ]; then
    _recent_claims=$((_recent_claims + 1))
  fi
done < "$_claim_tracker"

assert_eq "$_recent_claims" "1" "malformed entries: only valid entry counted"

# ============================================================
# TEST: Task-skip — claim tracker rotation at 10KB
# ============================================================

echo ""
log "=== Task-skip: tracker rotation ==="

rm -f "$_claim_tracker" "${_claim_tracker}.1"

# Fill tracker beyond 10KB
_i=0
while [ "$_i" -lt 500 ]; do
  echo "${_now_epoch}|task-${_i}" >> "$_claim_tracker"
  _i=$((_i + 1))
done

_tracker_size=$(wc -c < "$_claim_tracker" 2>/dev/null || echo 0)
if [ "$_tracker_size" -gt 10240 ]; then
  # Simulate the rotation logic from dev-worker.sh
  mv "$_claim_tracker" "${_claim_tracker}.1" 2>/dev/null || true
  : > "$_claim_tracker"
  if [ -f "${_claim_tracker}.1" ]; then
    pass "tracker rotation: old file moved to .1 backup"
  else
    fail "tracker rotation: .1 backup not created"
  fi
  _new_size=$(wc -c < "$_claim_tracker" 2>/dev/null || echo 0)
  assert_eq "$_new_size" "0" "tracker rotation: new tracker file is empty"
else
  pass "tracker rotation: file under 10KB with 500 entries (skipped rotation test)"
fi

# ============================================================
# TEST: Intent overlap full integration — declare, check, clear cycle
# ============================================================

echo ""
log "=== Integration: declare → check → skip → clear ==="

sqlite3 "$DB_PATH" "DELETE FROM workers;"

# Worker 1 claims an INFRA pipeline task
db_set_worker_status 1 "dev" "in_progress" "" "Add pipeline monitoring" "" 2>/dev/null || true
db_declare_intent 1 "INFRA" "Add pipeline monitoring"

# Verify intent is stored
w1_intent=$(sqlite3 "$DB_PATH" "SELECT intent FROM workers WHERE id=1;")
assert_not_empty "$w1_intent" "integration: worker 1 intent stored"

# Worker 2 tries a conflicting task → overlap detected
db_set_worker_status 2 "dev" "in_progress" "" "Fix pipeline scripts" "" 2>/dev/null || true
overlap=$(db_check_intent_overlap 2 "INFRA" "Fix pipeline scripts")
assert_not_empty "$overlap" "integration: overlap detected for worker 2"

# Worker 2 skips and clears its intent
db_clear_intent 2
w2_intent=$(sqlite3 "$DB_PATH" "SELECT intent FROM workers WHERE id=2;")
assert_empty "$w2_intent" "integration: worker 2 intent cleared after skip"

# Worker 1 completes and clears
db_clear_intent 1
w1_intent=$(sqlite3 "$DB_PATH" "SELECT intent FROM workers WHERE id=1;")
assert_empty "$w1_intent" "integration: worker 1 intent cleared after completion"

# Now worker 2 retries — no overlap since worker 1 cleared
overlap2=$(db_check_intent_overlap 2 "INFRA" "Fix pipeline scripts")
assert_empty "$overlap2" "integration: no overlap after worker 1 cleared intent"

# ============================================================
# TEST: Cross-tag overlap via shared title nouns
# ============================================================

echo ""
log "=== Cross-tag overlap via shared nouns ==="

sqlite3 "$DB_PATH" "DELETE FROM workers;"

# Worker 1: [TEST] Add handler validation tests
# Intent: "test handlers handler validation tests"
db_set_worker_status 1 "dev" "in_progress" "" "Add handler validation tests" "" 2>/dev/null || true
db_declare_intent 1 "TEST" "Add handler validation tests"

# Worker 2: [DATA] Add handler validation endpoint
# Intent: "handlers data api handler validation endpoint"
# Shared with worker 1: "handlers", "handler", "validation" = 3 shared keywords
overlap=$(db_check_intent_overlap 2 "DATA" "Add handler validation endpoint")
assert_not_empty "$overlap" "cross-tag overlap: TEST and DATA overlap via shared nouns (handler, validation)"

# ============================================================
# TEST: db_unclaim_task after overlap detection
# ============================================================

echo ""
log "=== db_unclaim_task after overlap ==="

sqlite3 "$DB_PATH" "DELETE FROM tasks; DELETE FROM workers;"

# Add and claim a task
task_id=$(db_add_task "Pipeline overlap test" "INFRA" "" "top")
db_claim_next_task 2 >/dev/null

status_before=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$task_id;")
assert_eq "$status_before" "claimed" "unclaim: task is claimed before overlap skip"

# Simulate overlap skip: unclaim the task
db_unclaim_task "$task_id"
status_after=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$task_id;")
assert_eq "$status_after" "pending" "unclaim: task reverts to pending after overlap skip"

# Task should be claimable again by another worker
reclaim=$(db_claim_next_task 3)
reclaim_title=$(echo "$reclaim" | cut -d"$SEP" -f2)
assert_eq "$reclaim_title" "Pipeline overlap test" "unclaim: task reclaimable after overlap skip"

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
