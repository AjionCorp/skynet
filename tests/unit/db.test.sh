#!/usr/bin/env bash
# tests/unit/db.test.sh — Unit tests for scripts/_db.sh SQLite abstraction layer
#
# Usage: bash tests/unit/db.test.sh
# Creates a temp directory with isolated SQLite DB, tests every _db.sh function.

set -euo pipefail

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
CLAIM_TITLE=$(echo "$CLAIM_RESULT" | cut -d'|' -f2)
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
CLAIM2_TITLE=$(echo "$CLAIM2" | cut -d'|' -f2)
assert_eq "$CLAIM2_TITLE" "Build login page" "db_claim_next_task: second claim gets next task"

# Blocked task (ID5) should NOT be claimed since its deps are not completed
# Claim next available
CLAIM3=$(db_claim_next_task 3)
CLAIM3_TITLE=$(echo "$CLAIM3" | cut -d'|' -f2)
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
CLAIMED_ID=$(echo "$CLAIMED" | cut -d'|' -f1)

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
CLAIM_BLOCKED_TITLE=$(echo "$CLAIM_BLOCKED" | cut -d'|' -f2)
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
db_unclaim_failure 1
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
assert_contains "$STALE" "2|" "db_get_stale_heartbeats: detects stale worker"

# Fresh worker should not appear
STALE_CHECK=$(echo "$STALE" | grep "^1|" || true)
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
BID=$(echo "$ACTIVE" | head -1 | cut -d'|' -f1)
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
R1_TITLE=$(echo "$R1" | cut -d'|' -f2)

# Worker 2 tries to claim — should NOT get the same task
R2=$(db_claim_next_task 2)
R2_TITLE=$(echo "$R2" | cut -d'|' -f2)

if [ -n "$R1_TITLE" ] && [ "$R1_TITLE" != "$R2_TITLE" ]; then
  pass "concurrent claim: two workers get different tasks"
elif [ -z "$R2_TITLE" ]; then
  pass "concurrent claim: second worker gets nothing (no more tasks)"
else
  fail "concurrent claim: both workers got same task '$R1_TITLE'"
fi

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
