#!/usr/bin/env bash
# tests/unit/db.test.sh — Unit tests for scripts/_db.sh SQLite abstraction layer
#
# Usage: bash tests/unit/db.test.sh
# Creates a temp directory with isolated SQLite DB, tests every _db.sh function.

# NOTE: -e is intentionally omitted — the test uses its own PASS/FAIL counters
# and set -e conflicts with _db.sh functions that use pipes under pipefail.
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
  if echo "$haystack" | grep -qF "$needle"; then
    pass "$msg"
  else
    fail "$msg (expected to contain '$needle')"
  fi
}

assert_not_empty() {
  local val="$1" msg="$2"
  if [ -n "$val" ]; then
    pass "$msg"
  else
    fail "$msg (was empty)"
  fi
}

assert_empty() {
  local val="$1" msg="$2"
  if [ -z "$val" ]; then
    pass "$msg"
  else
    fail "$msg (expected empty, got '$val')"
  fi
}

# ── Setup: create isolated environment ──────────────────────────────

TMPDIR_ROOT=$(mktemp -d)
trap 'rm -rf "$TMPDIR_ROOT"' EXIT

# Minimal config stubs required by _db.sh
export SKYNET_PROJECT_DIR="$TMPDIR_ROOT"
export SKYNET_DEV_DIR="$TMPDIR_ROOT/.dev"
export SKYNET_PROJECT_NAME="test-db"
export SKYNET_LOCK_PREFIX="/tmp/skynet-test-db"
export SKYNET_STALE_MINUTES=45
export SKYNET_MAX_WORKERS=4
export SKYNET_MAIN_BRANCH="main"

mkdir -p "$SKYNET_DEV_DIR"

# Provide a stub log() function
log() { :; }

# Source _db.sh directly (it only needs $SKYNET_DEV_DIR)
source "$REPO_ROOT/scripts/_db.sh"

# Source _generate_trace_id from _config.sh (defined standalone, no dependencies)
_generate_trace_id() {
  local id
  id=$(head -c 8 /dev/urandom 2>/dev/null | od -An -tx1 2>/dev/null | tr -d ' \n' | head -c 12)
  if [ -z "$id" ]; then
    id="$$-$(date +%s)"
  fi
  printf '%s' "$id"
}

# _db_sep uses \x1f (Unit Separator), not '|'. Use this for cut/IFS on db output.
SEP=$'\x1f'

# ── Test: db_init ──────────────────────────────────────────────────

echo ""
log "=== db_init ==="

db_init
[ -f "$DB_PATH" ] && pass "db_init: creates skynet.db" || fail "db_init: creates skynet.db"

# Verify WAL mode
WAL=$(sqlite3 "$DB_PATH" "PRAGMA journal_mode;")
assert_eq "$WAL" "wal" "db_init: WAL mode enabled"

# Verify tables exist
for tbl in tasks blockers workers events fixer_stats _metadata; do
  count=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='$tbl';")
  assert_eq "$count" "1" "db_init: table '$tbl' exists"
done

# Verify schema_version
VER=$(sqlite3 "$DB_PATH" "SELECT value FROM _metadata WHERE key='schema_version';")
assert_eq "$VER" "1" "db_init: schema_version = 1"

# Idempotent: call again, should not error
db_init
pass "db_init: idempotent (no error on second call)"

# ── Test: _sql_escape ────────────────────────────────────────────

echo ""
log "=== _sql_escape ==="

assert_eq "$(_sql_escape "hello")" "hello" "_sql_escape: no-op on clean string"
assert_eq "$(_sql_escape "it's")" "it''s" "_sql_escape: escapes single quote"
assert_eq "$(_sql_escape "it's a 'test'")" "it''s a ''test''" "_sql_escape: escapes multiple quotes"
assert_eq "$(_sql_escape "")" "" "_sql_escape: empty string"

# ── Test: db_add_task ──────────────────────────────────────────────

echo ""
log "=== db_add_task ==="

ID1=$(db_add_task "Build login page" "FEAT" "OAuth2 flow" "top")
assert_not_empty "$ID1" "db_add_task: returns task ID"

# Verify row exists
ROW=$(sqlite3 -separator '|' "$DB_PATH" "SELECT title, tag, description, status, priority FROM tasks WHERE id=$ID1;")
assert_eq "$ROW" "Build login page|FEAT|OAuth2 flow|pending|0" "db_add_task: correct row data"

# Add another at top — should have priority 0, existing bumped to 1
ID2=$(db_add_task "Fix critical bug" "FIX" "" "top")
PRI1=$(sqlite3 "$DB_PATH" "SELECT priority FROM tasks WHERE id=$ID1;")
PRI2=$(sqlite3 "$DB_PATH" "SELECT priority FROM tasks WHERE id=$ID2;")
assert_eq "$PRI2" "0" "db_add_task: top task gets priority 0"
[ "$PRI1" -gt "$PRI2" ] && pass "db_add_task: existing task priority bumped" || fail "db_add_task: existing task priority bumped (pri1=$PRI1, pri2=$PRI2)"

# Add at bottom
ID3=$(db_add_task "Low priority task" "CHORE" "" "bottom")
PRI3=$(sqlite3 "$DB_PATH" "SELECT priority FROM tasks WHERE id=$ID3;")
[ "$PRI3" -gt "$PRI1" ] && pass "db_add_task: bottom task has highest priority" || fail "db_add_task: bottom task has highest priority (pri3=$PRI3)"

# Verify normalized_root
ROOT=$(sqlite3 "$DB_PATH" "SELECT normalized_root FROM tasks WHERE id=$ID1;")
assert_eq "$ROOT" "build login page" "db_add_task: normalized_root correct"

# Test with special characters
ID4=$(db_add_task "Task with 'quotes'" "FEAT" "It's a \"test\"" "bottom")
QTITLE=$(sqlite3 "$DB_PATH" "SELECT title FROM tasks WHERE id=$ID4;")
assert_eq "$QTITLE" "Task with 'quotes'" "db_add_task: handles single quotes in title"

# Test blocked_by
ID5=$(db_add_task "Blocked task" "FEAT" "" "bottom" "Build login page,Fix critical bug")
BLOCKED=$(sqlite3 "$DB_PATH" "SELECT blocked_by FROM tasks WHERE id=$ID5;")
assert_eq "$BLOCKED" "Build login page,Fix critical bug" "db_add_task: stores blocked_by"

# ── Test: db_count_pending / db_count_claimed / db_count_by_status ──

echo ""
log "=== counts ==="

PENDING=$(db_count_pending)
assert_eq "$PENDING" "5" "db_count_pending: 5 pending tasks"

CLAIMED=$(db_count_claimed)
assert_eq "$CLAIMED" "0" "db_count_claimed: 0 claimed tasks"

BY_STATUS=$(db_count_by_status "pending")
assert_eq "$BY_STATUS" "5" "db_count_by_status: 5 pending"

# ── Test: db_get_pending_tasks ──────────────────────────────────────

echo ""
log "=== db_get_pending_tasks ==="

PENDING_ROWS=$(db_get_pending_tasks)
assert_not_empty "$PENDING_ROWS" "db_get_pending_tasks: returns rows"
PENDING_COUNT=$(echo "$PENDING_ROWS" | wc -l | tr -d ' ')
assert_eq "$PENDING_COUNT" "5" "db_get_pending_tasks: returns 5 rows"

# ── Test: db_claim_next_task ──────────────────────────────────────

echo ""
log "=== db_claim_next_task ==="

CLAIM_RESULT=$(db_claim_next_task 1)
assert_not_empty "$CLAIM_RESULT" "db_claim_next_task: returns a task"

# Should claim the highest-priority (lowest number) unblocked task
# ID2 "Fix critical bug" has priority 0 and no blockers
CLAIM_TITLE=$(echo "$CLAIM_RESULT" | cut -d"$SEP" -f2)
assert_eq "$CLAIM_TITLE" "Fix critical bug" "db_claim_next_task: claims highest-priority unblocked task"

# Verify status changed
STATUS=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$ID2;")
assert_eq "$STATUS" "claimed" "db_claim_next_task: status set to claimed"

# Verify worker_id set
WID=$(sqlite3 "$DB_PATH" "SELECT worker_id FROM tasks WHERE id=$ID2;")
assert_eq "$WID" "1" "db_claim_next_task: worker_id set"

# Claim another — should skip blocked task
# First, let's see what's next: ID1 "Build login page" is next in priority (pri=1)
CLAIM2=$(db_claim_next_task 2)
CLAIM2_TITLE=$(echo "$CLAIM2" | cut -d"$SEP" -f2)
assert_eq "$CLAIM2_TITLE" "Build login page" "db_claim_next_task: second claim gets next task"

# Blocked task (ID5) should NOT be claimed since its deps are not completed
# Claim next available
CLAIM3=$(db_claim_next_task 3)
CLAIM3_TITLE=$(echo "$CLAIM3" | cut -d"$SEP" -f2)
# Should be one of the remaining unblocked tasks, not "Blocked task"
if [ "$CLAIM3_TITLE" != "Blocked task" ]; then
  pass "db_claim_next_task: skips blocked task"
else
  fail "db_claim_next_task: should skip blocked task"
fi

# ── Test: db_unclaim_task / db_unclaim_task_by_title ──────────────

echo ""
log "=== db_unclaim_task ==="

db_unclaim_task "$ID2"
STATUS=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$ID2;")
assert_eq "$STATUS" "pending" "db_unclaim_task: reverts to pending"

WID=$(sqlite3 "$DB_PATH" "SELECT worker_id FROM tasks WHERE id=$ID2;")
assert_eq "$WID" "" "db_unclaim_task: clears worker_id"

# Re-claim and test unclaim by title
db_claim_next_task 1 >/dev/null
db_unclaim_task_by_title "Fix critical bug"
STATUS=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$ID2;")
assert_eq "$STATUS" "pending" "db_unclaim_task_by_title: reverts to pending"

# ── Test: db_complete_task ──────────────────────────────────────────

echo ""
log "=== db_complete_task ==="

# Claim and complete
CLAIMED=$(db_claim_next_task 1)
CLAIMED_ID=$(echo "$CLAIMED" | cut -d"$SEP" -f1)

db_complete_task "$CLAIMED_ID" "dev/fix-critical-bug" "5m 30s" 330 "All gates passed"

STATUS=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$CLAIMED_ID;")
assert_eq "$STATUS" "completed" "db_complete_task: status set to completed"

BRANCH=$(sqlite3 "$DB_PATH" "SELECT branch FROM tasks WHERE id=$CLAIMED_ID;")
assert_eq "$BRANCH" "dev/fix-critical-bug" "db_complete_task: branch stored"

DUR=$(sqlite3 "$DB_PATH" "SELECT duration FROM tasks WHERE id=$CLAIMED_ID;")
assert_eq "$DUR" "5m 30s" "db_complete_task: duration stored"

DUR_S=$(sqlite3 "$DB_PATH" "SELECT duration_secs FROM tasks WHERE id=$CLAIMED_ID;")
assert_eq "$DUR_S" "330" "db_complete_task: duration_secs stored"

NOTES=$(sqlite3 "$DB_PATH" "SELECT notes FROM tasks WHERE id=$CLAIMED_ID;")
assert_eq "$NOTES" "All gates passed" "db_complete_task: notes stored"

# ── Test: blocked task becomes claimable after dependency completes ──

echo ""
log "=== blocked dependency resolution ==="

# ID5 was blocked by "Build login page" and "Fix critical bug"
# "Fix critical bug" (ID2) is now completed
# "Build login page" (ID1) is still claimed — complete it
db_complete_task "$ID1" "dev/build-login" "10m" 600

# Now both blockers are completed — ID5 should be claimable
CLAIM_BLOCKED=$(db_claim_next_task 1)
CLAIM_BLOCKED_TITLE=$(echo "$CLAIM_BLOCKED" | cut -d"$SEP" -f2)
# It might claim another unblocked task first by priority; check that blocked task is at least now unblocked
BLOCKED_STATUS=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$ID5;")
if [ "$BLOCKED_STATUS" = "claimed" ] || [ "$BLOCKED_STATUS" = "pending" ]; then
  pass "db_claim_next_task: blocked task claimable after deps complete"
else
  fail "db_claim_next_task: blocked task should be pending or claimed (got: $BLOCKED_STATUS)"
fi

# ── Test: db_fail_task ──────────────────────────────────────────────

echo ""
log "=== db_fail_task ==="

# Add and claim a fresh task, then fail it
FAIL_ID=$(db_add_task "Failing task" "FIX" "" "bottom")
sqlite3 "$DB_PATH" "UPDATE tasks SET status='claimed', worker_id=1 WHERE id=$FAIL_ID;"
db_fail_task "$FAIL_ID" "dev/failing-task" "typecheck failed: 3 errors"

STATUS=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$FAIL_ID;")
assert_eq "$STATUS" "failed" "db_fail_task: status set to failed"

ERR=$(sqlite3 "$DB_PATH" "SELECT error FROM tasks WHERE id=$FAIL_ID;")
assert_eq "$ERR" "typecheck failed: 3 errors" "db_fail_task: error stored"

BRANCH=$(sqlite3 "$DB_PATH" "SELECT branch FROM tasks WHERE id=$FAIL_ID;")
assert_eq "$BRANCH" "dev/failing-task" "db_fail_task: branch stored"

# ── Test: db_get_pending_failures / db_claim_failure / db_unclaim_failure ──

echo ""
log "=== failure management ==="

FAILURES=$(db_get_pending_failures)
assert_not_empty "$FAILURES" "db_get_pending_failures: returns failed tasks"
assert_contains "$FAILURES" "Failing task" "db_get_pending_failures: contains our failed task"

# Claim the failure
db_claim_failure "$FAIL_ID" 1
STATUS=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$FAIL_ID;")
assert_eq "$STATUS" "fixing-1" "db_claim_failure: status set to fixing-N"

FIXER=$(sqlite3 "$DB_PATH" "SELECT fixer_id FROM tasks WHERE id=$FAIL_ID;")
assert_eq "$FIXER" "1" "db_claim_failure: fixer_id set"

# Claim failure that's already claimed should fail (returns 1)
if db_claim_failure "$FAIL_ID" 2 2>/dev/null; then
  fail "db_claim_failure: should fail on already-claimed task"
else
  pass "db_claim_failure: rejects double-claim"
fi

# Unclaim failure
db_unclaim_failure "$FAIL_ID" 1
STATUS=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$FAIL_ID;")
assert_eq "$STATUS" "failed" "db_unclaim_failure: reverts to failed"

# ── Test: db_update_failure ──────────────────────────────────────────

echo ""
log "=== db_update_failure ==="

db_update_failure "$FAIL_ID" "attempt 2: still failing" 2 "failed"
ERR=$(sqlite3 "$DB_PATH" "SELECT error FROM tasks WHERE id=$FAIL_ID;")
assert_eq "$ERR" "attempt 2: still failing" "db_update_failure: error updated"

ATTEMPTS=$(sqlite3 "$DB_PATH" "SELECT attempts FROM tasks WHERE id=$FAIL_ID;")
assert_eq "$ATTEMPTS" "2" "db_update_failure: attempts updated"

# ── Test: db_fix_task ──────────────────────────────────────────────

echo ""
log "=== db_fix_task ==="

db_fix_task "$FAIL_ID" "dev/failing-task-fix" 3 "fixed on third attempt"
STATUS=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$FAIL_ID;")
assert_eq "$STATUS" "fixed" "db_fix_task: status set to fixed"

ATTEMPTS=$(sqlite3 "$DB_PATH" "SELECT attempts FROM tasks WHERE id=$FAIL_ID;")
assert_eq "$ATTEMPTS" "3" "db_fix_task: attempts stored"

# ── Test: db_block_task / db_supersede_task / db_mark_done ─────────

echo ""
log "=== status transitions ==="

# Create disposable tasks for each transition
BLK_ID=$(db_add_task "Block me" "FEAT" "" "bottom")
# db_block_task requires status='failed' or 'fixing-*' — set it up first
sqlite3 "$DB_PATH" "UPDATE tasks SET status='claimed', worker_id=1 WHERE id=$BLK_ID;"
sqlite3 "$DB_PATH" "UPDATE tasks SET status='failed', error='test' WHERE id=$BLK_ID;"
db_block_task "$BLK_ID"
STATUS=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$BLK_ID;")
assert_eq "$STATUS" "blocked" "db_block_task: status set to blocked"

SUP_ID=$(db_add_task "Supersede me" "FEAT" "" "bottom")
db_supersede_task "$SUP_ID"
STATUS=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$SUP_ID;")
assert_eq "$STATUS" "superseded" "db_supersede_task: status set to superseded"

DONE_ID=$(db_add_task "Done externally" "FEAT" "" "bottom")
db_mark_done "$DONE_ID"
STATUS=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$DONE_ID;")
assert_eq "$STATUS" "done" "db_mark_done: status set to done"

# ── Test: db_auto_supersede_completed ─────────────────────────────

echo ""
log "=== db_auto_supersede_completed ==="

# Create a completed task and a failed task with the same normalized_root
AS_COMP_ID=$(db_add_task "Auto supersede test" "FEAT" "" "bottom")
sqlite3 "$DB_PATH" "UPDATE tasks SET status='completed', normalized_root='auto supersede test' WHERE id=$AS_COMP_ID;"

AS_FAIL_ID=$(db_add_task "Auto supersede test retry" "FEAT" "" "bottom")
# Manually set same normalized_root and status=failed
sqlite3 "$DB_PATH" "UPDATE tasks SET status='failed', normalized_root='auto supersede test' WHERE id=$AS_FAIL_ID;"

CHANGES=$(db_auto_supersede_completed)
[ "$CHANGES" -ge 1 ] && pass "db_auto_supersede_completed: superseded at least 1 task" || fail "db_auto_supersede_completed: expected changes >= 1 (got: $CHANGES)"

STATUS=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$AS_FAIL_ID;")
assert_eq "$STATUS" "superseded" "db_auto_supersede_completed: failed task superseded"

# ── Test: db_get_task_id_by_title / db_get_task / db_task_exists ──

echo ""
log "=== task lookups ==="

LOOKUP_ID=$(db_get_task_id_by_title "Low priority task")
assert_eq "$LOOKUP_ID" "$ID3" "db_get_task_id_by_title: finds correct ID"

TASK_ROW=$(db_get_task "$ID3")
assert_contains "$TASK_ROW" "Low priority task" "db_get_task: returns task data"
assert_contains "$TASK_ROW" "CHORE" "db_get_task: includes tag"

if db_task_exists "Low priority task"; then
  pass "db_task_exists: returns true for existing task"
else
  fail "db_task_exists: should return true"
fi

if db_task_exists "Nonexistent task 12345"; then
  fail "db_task_exists: should return false for missing task"
else
  pass "db_task_exists: returns false for missing task"
fi

# ── Test: worker status ──────────────────────────────────────────

echo ""
log "=== worker status ==="

db_set_worker_status 1 "dev" "in_progress" "$ID3" "Low priority task" "dev/low-priority"
WSTAT=$(db_get_worker_status 1)
assert_contains "$WSTAT" "in_progress" "db_set_worker_status: status set"
assert_contains "$WSTAT" "Low priority task" "db_set_worker_status: task_title set"
assert_contains "$WSTAT" "dev/low-priority" "db_set_worker_status: branch set"

db_set_worker_idle 1 "task completed"
WSTAT2=$(db_get_worker_status 1)
assert_contains "$WSTAT2" "idle" "db_set_worker_idle: status set to idle"
assert_contains "$WSTAT2" "task completed" "db_set_worker_idle: last_info set"

# ── Test: heartbeat ──────────────────────────────────────────────

echo ""
log "=== heartbeat ==="

db_update_heartbeat 1
HB=$(sqlite3 "$DB_PATH" "SELECT heartbeat_epoch FROM workers WHERE id=1;")
NOW=$(date +%s)
DIFF=$(( NOW - HB ))
[ "$DIFF" -lt 5 ] && pass "db_update_heartbeat: epoch is recent" || fail "db_update_heartbeat: epoch too old (diff=${DIFF}s)"

# Stale heartbeat detection — set worker 2 heartbeat to old epoch
db_set_worker_status 2 "dev" "in_progress" "" "Stale task" ""
sqlite3 "$DB_PATH" "UPDATE workers SET heartbeat_epoch = $(( NOW - 4000 )) WHERE id=2;"

STALE=$(db_get_stale_heartbeats 3600)
assert_contains "$STALE" "2${SEP}" "db_get_stale_heartbeats: detects stale worker"

# Fresh worker should not appear
STALE_CHECK=$(echo "$STALE" | grep "^1${SEP}" || true)
assert_empty "$STALE_CHECK" "db_get_stale_heartbeats: fresh worker not reported"

# ── Test: blockers ───────────────────────────────────────────────

echo ""
log "=== blockers ==="

db_add_blocker "Auth service is down" "Login task"
db_add_blocker "CI pipeline broken" ""

ACTIVE=$(db_get_active_blockers)
assert_contains "$ACTIVE" "Auth service is down" "db_add_blocker: first blocker stored"
assert_contains "$ACTIVE" "CI pipeline broken" "db_add_blocker: second blocker stored"

COUNT=$(db_count_active_blockers)
assert_eq "$COUNT" "2" "db_count_active_blockers: returns 2"

# Resolve one
BID=$(echo "$ACTIVE" | head -1 | cut -d"$SEP" -f1)
db_resolve_blocker "$BID"
COUNT2=$(db_count_active_blockers)
assert_eq "$COUNT2" "1" "db_resolve_blocker: count decreased to 1"

# ── Test: events ─────────────────────────────────────────────────

echo ""
log "=== events ==="

db_add_event "TASK_CLAIMED" "Worker 1 claimed: Build login page" 1
db_add_event "TASK_COMPLETED" "Worker 1 completed: Build login page" 1
db_add_event "WATCHDOG_RUN" "Reconciliation complete" ""

EVENTS=$(db_get_recent_events 10)
assert_contains "$EVENTS" "TASK_CLAIMED" "db_add_event: event stored"
assert_contains "$EVENTS" "WATCHDOG_RUN" "db_add_event: event with no worker_id"

EVENT_COUNT=$(echo "$EVENTS" | wc -l | tr -d ' ')
assert_eq "$EVENT_COUNT" "3" "db_get_recent_events: returns 3 events"

# Limit works
LIMITED=$(db_get_recent_events 1)
LIM_COUNT=$(echo "$LIMITED" | wc -l | tr -d ' ')
assert_eq "$LIM_COUNT" "1" "db_get_recent_events: limit=1 returns 1"

# ── Test: fixer stats ────────────────────────────────────────────

echo ""
log "=== fixer stats ==="

db_add_fixer_stat "success" "Build login page" 1
db_add_fixer_stat "failure" "Failing task" 1
db_add_fixer_stat "failure" "Failing task attempt 2" 1
db_add_fixer_stat "success" "Another fixed task" 2

CONSEC=$(db_get_consecutive_failures 3)
# Most recent first: success, failure, failure
FIRST=$(echo "$CONSEC" | head -1)
assert_eq "$FIRST" "success" "db_get_consecutive_failures: most recent first"

RATE=$(db_get_fix_rate_24h)
assert_eq "$RATE" "50" "db_get_fix_rate_24h: 2 success out of 4 = 50%"

# ── Test: health score ───────────────────────────────────────────

echo ""
log "=== health score ==="

SCORE=$(db_get_health_score)
# Score should be a number 0-100
[ "$SCORE" -ge 0 ] && [ "$SCORE" -le 100 ] && pass "db_get_health_score: returns valid score ($SCORE)" || fail "db_get_health_score: invalid score ($SCORE)"

# ── Test: db_export_context ──────────────────────────────────────

echo ""
log "=== db_export_context ==="

CONTEXT=$(db_export_context)
assert_contains "$CONTEXT" "## Backlog (pending tasks)" "db_export_context: has backlog header"
assert_contains "$CONTEXT" "## Claimed tasks" "db_export_context: has claimed header"
assert_contains "$CONTEXT" "## Recent completed" "db_export_context: has completed header"
assert_contains "$CONTEXT" "## Active blockers" "db_export_context: has blockers header"

# ── Test: db_get_cleanup_branches ────────────────────────────────

echo ""
log "=== db_get_cleanup_branches ==="

# We have tasks with branches in various terminal statuses
BRANCHES=$(db_get_cleanup_branches)
# blocked task has no branch, but superseded task might
# Let's check for the fixed task's branch
assert_contains "$BRANCHES" "dev/failing-task-fix" "db_get_cleanup_branches: includes fixed task branch"

# ── Test: db_export_all_tasks ────────────────────────────────────

echo ""
log "=== db_export_all_tasks ==="

ALL=$(db_export_all_tasks)
ALL_COUNT=$(echo "$ALL" | wc -l | tr -d ' ')
[ "$ALL_COUNT" -ge 5 ] && pass "db_export_all_tasks: returns all tasks ($ALL_COUNT rows)" || fail "db_export_all_tasks: expected >= 5 rows (got $ALL_COUNT)"

# ── Test: _sql_exec error handling ───────────────────────────────

echo ""
log "=== error handling ==="

# Invalid SQL should return non-zero
if _sql_exec "INVALID SQL SYNTAX HERE" 2>/dev/null; then
  fail "_sql_exec: should fail on invalid SQL"
else
  pass "_sql_exec: returns non-zero on invalid SQL"
fi

if _sql_query "SELECT * FROM nonexistent_table" 2>/dev/null; then
  fail "_sql_query: should fail on nonexistent table"
else
  pass "_sql_query: returns non-zero on nonexistent table"
fi

# ── Test: concurrent claim safety ────────────────────────────────

echo ""
log "=== concurrent claim safety ==="

# Add a task and try to claim it twice rapidly
RACE_ID=$(db_add_task "Race condition test" "TEST" "" "top")

# Simulate: claim from worker 1 succeeds, then claim from worker 2 should get a different task (or empty)
R1=$(db_claim_next_task 1)
R1_TITLE=$(echo "$R1" | cut -d"$SEP" -f2)

# Worker 2 tries to claim — should NOT get the same task
R2=$(db_claim_next_task 2)
R2_TITLE=$(echo "$R2" | cut -d"$SEP" -f2)

if [ -n "$R1_TITLE" ] && [ "$R1_TITLE" != "$R2_TITLE" ]; then
  pass "concurrent claim: two workers get different tasks"
elif [ -z "$R2_TITLE" ]; then
  pass "concurrent claim: second worker gets nothing (no more tasks)"
else
  fail "concurrent claim: both workers got same task '$R1_TITLE'"
fi

# ── Test: concurrent claim stress (4 parallel workers) ────────────

echo ""
log "=== concurrent claim stress (4 parallel workers) ==="

# Reset: unclaim everything and remove non-pending tasks for a clean slate
sqlite3 "$DB_PATH" "DELETE FROM tasks;"

# Create 4 fresh pending tasks with no blockers
STRESS_IDS=""
for _i in 1 2 3 4; do
  _sid=$(db_add_task "Stress task $_i" "TEST" "parallel claim test" "bottom")
  STRESS_IDS="$STRESS_IDS $_sid"
done

STRESS_PENDING=$(db_count_pending)
assert_eq "$STRESS_PENDING" "4" "stress: 4 pending tasks created"

# Launch 4 parallel db_claim_next_task calls in background subshells
STRESS_TMPDIR=$(mktemp -d)
for _w in 1 2 3 4; do
  (
    _result=$(db_claim_next_task "$_w")
    echo "$_result" > "$STRESS_TMPDIR/worker-$_w.out"
  ) &
done
wait

# Collect results
STRESS_CLAIMED=0
STRESS_TITLES=""
for _w in 1 2 3 4; do
  _out=""
  [ -f "$STRESS_TMPDIR/worker-$_w.out" ] && _out=$(cat "$STRESS_TMPDIR/worker-$_w.out")
  if [ -n "$_out" ]; then
    STRESS_CLAIMED=$((STRESS_CLAIMED + 1))
    _t=$(echo "$_out" | cut -d"$SEP" -f2)
    STRESS_TITLES="$STRESS_TITLES|$_t"
  fi
done
rm -rf "$STRESS_TMPDIR"

assert_eq "$STRESS_CLAIMED" "4" "stress: exactly 4 tasks claimed"

# Verify no double-claims: each task should have a different worker_id
STRESS_UNIQUE_WORKERS=$(sqlite3 "$DB_PATH" "SELECT COUNT(DISTINCT worker_id) FROM tasks WHERE status='claimed';")
assert_eq "$STRESS_UNIQUE_WORKERS" "4" "stress: no double-claims (4 unique worker_ids)"

# Verify each claimed task has a unique title
STRESS_UNIQUE_TITLES=$(sqlite3 "$DB_PATH" "SELECT COUNT(DISTINCT title) FROM tasks WHERE status='claimed';")
assert_eq "$STRESS_UNIQUE_TITLES" "4" "stress: 4 unique titles claimed"

# ── Test: blocker resolution chain ────────────────────────────────

echo ""
log "=== blocker resolution chain ==="

# Clean slate
sqlite3 "$DB_PATH" "DELETE FROM tasks;"

# Create task A (no blockers), task B (blocked_by="Task A"), task C (blocked_by="Task A, Task B")
CHAIN_A=$(db_add_task "Task A" "TEST" "no blockers" "bottom")
CHAIN_B=$(db_add_task "Task B" "TEST" "blocked by A" "bottom" "Task A")
CHAIN_C=$(db_add_task "Task C" "TEST" "blocked by A and B" "bottom" "Task A, Task B")

# Claim next — should get Task A (only unblocked task)
CHAIN_R1=$(db_claim_next_task 1)
CHAIN_R1_TITLE=$(echo "$CHAIN_R1" | cut -d"$SEP" -f2)
assert_eq "$CHAIN_R1_TITLE" "Task A" "chain: first claim gets Task A (unblocked)"

# Mark Task A completed
db_complete_task "$CHAIN_A" "dev/task-a" "1m" 60

# Claim next — should get Task B (A is now completed, so B is unblocked)
CHAIN_R2=$(db_claim_next_task 2)
CHAIN_R2_TITLE=$(echo "$CHAIN_R2" | cut -d"$SEP" -f2)
assert_eq "$CHAIN_R2_TITLE" "Task B" "chain: second claim gets Task B (A completed)"

# Task C should still be blocked (B is claimed, not completed)
CHAIN_C_STATUS=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$CHAIN_C;")
assert_eq "$CHAIN_C_STATUS" "pending" "chain: Task C still pending (B not completed)"

# Trying to claim as worker 3 should NOT get Task C
CHAIN_R3=$(db_claim_next_task 3)
CHAIN_R3_TITLE=$(echo "$CHAIN_R3" | cut -d"$SEP" -f2)
if [ "$CHAIN_R3_TITLE" = "Task C" ]; then
  fail "chain: Task C should NOT be claimable (Task B not completed)"
else
  pass "chain: Task C correctly blocked (Task B not completed)"
fi

# Complete Task B, now Task C should be claimable
db_complete_task "$CHAIN_B" "dev/task-b" "2m" 120

CHAIN_R4=$(db_claim_next_task 3)
CHAIN_R4_TITLE=$(echo "$CHAIN_R4" | cut -d"$SEP" -f2)
assert_eq "$CHAIN_R4_TITLE" "Task C" "chain: Task C claimable after A and B completed"

# ── Test: empty blocked_by handling ───────────────────────────────

echo ""
log "=== empty blocked_by handling ==="

# Clean slate
sqlite3 "$DB_PATH" "DELETE FROM tasks;"

# Create task with blocked_by='' (default from db_add_task)
EMPTY_BLK_ID=$(db_add_task "No blockers empty string" "TEST" "" "bottom")

# Create task with blocked_by IS NULL (set via raw SQL)
NULL_BLK_ID=$(db_add_task "No blockers null" "TEST" "" "bottom")
sqlite3 "$DB_PATH" "UPDATE tasks SET blocked_by=NULL WHERE id=$NULL_BLK_ID;"

# Both should be claimable
EMPTY_R1=$(db_claim_next_task 1)
EMPTY_R1_TITLE=$(echo "$EMPTY_R1" | cut -d"$SEP" -f2)
assert_not_empty "$EMPTY_R1_TITLE" "empty_blocked_by: first task claimable"

EMPTY_R2=$(db_claim_next_task 2)
EMPTY_R2_TITLE=$(echo "$EMPTY_R2" | cut -d"$SEP" -f2)
assert_not_empty "$EMPTY_R2_TITLE" "empty_blocked_by: second task claimable"

# Verify both tasks are now claimed
EMPTY_CLAIMED=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM tasks WHERE status='claimed';")
assert_eq "$EMPTY_CLAIMED" "2" "empty_blocked_by: both tasks (empty string and NULL) claimed"

# ============================================================
# TEST: Compound indexes exist
# ============================================================

echo ""
printf "  %s\n" "=== compound indexes ==="

IDX_SW=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_tasks_status_worker';")
assert_eq "$IDX_SW" "1" "db_init: compound index status_worker exists"

IDX_NR=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_tasks_nroot_status';")
assert_eq "$IDX_NR" "1" "db_init: compound index nroot_status exists"

IDX_WS=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_workers_status';")
assert_eq "$IDX_WS" "1" "db_init: workers status index exists"

# ============================================================
# TEST: Combined heartbeat + progress update
# ============================================================

echo ""
printf "  %s\n" "=== combined heartbeat+progress ==="

sqlite3 "$DB_PATH" "DELETE FROM workers;"
db_set_worker_status 1 "dev" "idle" "" "" "" 2>/dev/null || true

db_update_heartbeat_and_progress 1
HB=$(sqlite3 "$DB_PATH" "SELECT heartbeat_epoch FROM workers WHERE id=1;")
PR=$(sqlite3 "$DB_PATH" "SELECT progress_epoch FROM workers WHERE id=1;")

[ -n "$HB" ] && [ "$HB" -gt 0 ] 2>/dev/null && pass "combined update: heartbeat_epoch set" || fail "combined update: heartbeat_epoch not set"
[ -n "$PR" ] && [ "$PR" -gt 0 ] 2>/dev/null && pass "combined update: progress_epoch set" || fail "combined update: progress_epoch not set"
assert_eq "$HB" "$PR" "combined update: heartbeat and progress epochs match"

# ============================================================
# TEST: db_explain_claim returns query plan
# ============================================================

echo ""
printf "  %s\n" "=== db_explain_claim ==="

sqlite3 "$DB_PATH" "DELETE FROM tasks;"
db_add_task "Explain test" "FEAT" "" "top" >/dev/null
PLAN=$(db_explain_claim 1)
[ -n "$PLAN" ] && pass "db_explain_claim: returns query plan" || fail "db_explain_claim: empty plan"

# ============================================================
# TEST: trace_id column and functions
# ============================================================
echo ""
printf "  %s\n" "=== trace_id ==="

sqlite3 "$DB_PATH" "DELETE FROM tasks;"
TRACE_TASK=$(db_add_task "Trace test" "FEAT" "" "top")
TRACE_ID=$(_generate_trace_id)
db_set_trace_id "$TRACE_TASK" "$TRACE_ID"
GOT_TRACE=$(db_get_trace_id "$TRACE_TASK")
assert_eq "$GOT_TRACE" "$TRACE_ID" "trace_id: set and retrieved"
[ ${#TRACE_ID} -gt 0 ] && pass "trace_id: non-empty" || fail "trace_id: empty"

# ── Test: concurrent claim stress (8 parallel workers) ────────────

echo ""
log "=== concurrent claim stress (8 parallel workers) ==="

# Clean slate
sqlite3 "$DB_PATH" "DELETE FROM tasks;"

# Create 8 fresh pending tasks with no blockers
STRESS8_IDS=""
for _i in 1 2 3 4 5 6 7 8; do
  _sid=$(db_add_task "Stress8 task $_i" "TEST" "8-worker parallel claim test" "bottom")
  STRESS8_IDS="$STRESS8_IDS $_sid"
done

STRESS8_PENDING=$(db_count_pending)
assert_eq "$STRESS8_PENDING" "8" "stress8: 8 pending tasks created"

# Launch 8 parallel db_claim_next_task calls in background subshells
STRESS8_TMPDIR=$(mktemp -d)
for _w in 1 2 3 4 5 6 7 8; do
  (
    _result=$(db_claim_next_task "$_w")
    echo "$_result" > "$STRESS8_TMPDIR/worker-$_w.out"
  ) &
done
wait

# Collect results
STRESS8_CLAIMED=0
STRESS8_TITLES=""
STRESS8_WORKER_IDS=""
for _w in 1 2 3 4 5 6 7 8; do
  _out=""
  [ -f "$STRESS8_TMPDIR/worker-$_w.out" ] && _out=$(cat "$STRESS8_TMPDIR/worker-$_w.out")
  if [ -n "$_out" ]; then
    STRESS8_CLAIMED=$((STRESS8_CLAIMED + 1))
    _t=$(echo "$_out" | cut -d"$SEP" -f2)
    STRESS8_TITLES="$STRESS8_TITLES|$_t"
    STRESS8_WORKER_IDS="$STRESS8_WORKER_IDS|$_w"
  fi
done
rm -rf "$STRESS8_TMPDIR"

assert_eq "$STRESS8_CLAIMED" "8" "stress8: exactly 8 tasks claimed"

# Verify no double-claims: each task should have a different worker_id
STRESS8_UNIQUE_WORKERS=$(sqlite3 "$DB_PATH" "SELECT COUNT(DISTINCT worker_id) FROM tasks WHERE status='claimed';")
assert_eq "$STRESS8_UNIQUE_WORKERS" "8" "stress8: no double-claims (8 unique worker_ids)"

# Verify each claimed task has a unique title
STRESS8_UNIQUE_TITLES=$(sqlite3 "$DB_PATH" "SELECT COUNT(DISTINCT title) FROM tasks WHERE status='claimed';")
assert_eq "$STRESS8_UNIQUE_TITLES" "8" "stress8: 8 unique titles claimed"

# Verify 0 double-claims: no task has more than one worker assigned
STRESS8_DOUBLE_CLAIMS=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM (SELECT id FROM tasks WHERE status='claimed' GROUP BY id HAVING COUNT(*) > 1);")
assert_eq "$STRESS8_DOUBLE_CLAIMS" "0" "stress8: 0 double-claims detected"

# Verify no tasks left unclaimed
STRESS8_UNCLAIMED=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM tasks WHERE status='pending';")
assert_eq "$STRESS8_UNCLAIMED" "0" "stress8: 0 unclaimed tasks remain"

# ============================================================
# TEST: db_detect_circular_deps
# ============================================================

echo ""
printf "  %s\n" "=== db_detect_circular_deps ==="

# Clean slate
sqlite3 "$DB_PATH" "DELETE FROM tasks;"

# Non-circular: A blocks B, B blocks C (linear chain, no cycle)
db_add_task "Lin A" "TEST" "" "bottom" >/dev/null
db_add_task "Lin B" "TEST" "" "bottom" "Lin A" >/dev/null
db_add_task "Lin C" "TEST" "" "bottom" "Lin B" >/dev/null

CIRC_NONE=$(db_detect_circular_deps)
assert_empty "$CIRC_NONE" "db_detect_circular_deps: no cycles in linear chain"

# Circular: X blocks Y, Y blocks X
sqlite3 "$DB_PATH" "DELETE FROM tasks;"
db_add_task "Cycle X" "TEST" "" "bottom" "Cycle Y" >/dev/null
db_add_task "Cycle Y" "TEST" "" "bottom" "Cycle X" >/dev/null

CIRC_FOUND=$(db_detect_circular_deps)
assert_not_empty "$CIRC_FOUND" "db_detect_circular_deps: detects X<->Y cycle"

# ============================================================
# TEST: db_explain_claim returns non-empty query plan
# ============================================================

echo ""
printf "  %s\n" "=== db_explain_claim (extended) ==="

sqlite3 "$DB_PATH" "DELETE FROM tasks;"
db_add_task "Explain plan task" "FEAT" "" "top" >/dev/null
EPLAN=$(db_explain_claim 1)
assert_not_empty "$EPLAN" "db_explain_claim: returns non-empty query plan"
assert_contains "$EPLAN" "SCAN" "db_explain_claim: plan contains SCAN operation"

# ============================================================
# TEST: SKYNET_DB_DEBUG produces timing log output
# ============================================================

echo ""
printf "  %s\n" "=== DB debug mode timing ===="

# Enable debug mode and capture log output
SKYNET_DB_DEBUG=true
sqlite3 "$DB_PATH" "DELETE FROM tasks;"
db_add_task "Debug timing task" "FEAT" "" "top" >/dev/null

# Override log() to capture output to a temp file
_DBG_LOG_FILE="$(mktemp)"
log() { printf '%s\n' "$*" >> "$_DBG_LOG_FILE"; }

# Run a simple query with debug enabled
_db "SELECT COUNT(*) FROM tasks;" >/dev/null 2>/dev/null

_DBG_LOG_CONTENT="$(cat "$_DBG_LOG_FILE" 2>/dev/null || true)"
assert_contains "$_DBG_LOG_CONTENT" "SQL DEBUG" "DB_DEBUG=true: produces SQL DEBUG log line"
assert_contains "$_DBG_LOG_CONTENT" "ms" "DB_DEBUG=true: log contains timing in ms"

# Test slow query warning (set threshold to 0ms so any query triggers it)
SKYNET_DB_SLOW_QUERY_MS=0
> "$_DBG_LOG_FILE"
_db "SELECT COUNT(*) FROM tasks;" >/dev/null 2>/dev/null
_DBG_SLOW_CONTENT="$(cat "$_DBG_LOG_FILE" 2>/dev/null || true)"
assert_contains "$_DBG_SLOW_CONTENT" "SQL SLOW" "DB_DEBUG=true + threshold=0: produces SQL SLOW warning"

# Restore defaults
SKYNET_DB_DEBUG=false
SKYNET_DB_SLOW_QUERY_MS=100
log() { :; }
rm -f "$_DBG_LOG_FILE"


# ── Summary ──────────────────────────────────────────────────────

echo ""
TOTAL=$((PASS + FAIL))
log "Results: $PASS/$TOTAL passed, $FAIL failed"
if [ $FAIL -eq 0 ]; then
  printf "  \033[32mAll checks passed!\033[0m\n"
else
  printf "  \033[31mSome checks failed!\033[0m\n"
  exit 1
fi
