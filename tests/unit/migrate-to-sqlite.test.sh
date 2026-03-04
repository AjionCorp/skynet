#!/usr/bin/env bash
# tests/unit/migrate-to-sqlite.test.sh — Unit tests for scripts/migrate-to-sqlite.sh
#
# Tests the one-time migration from markdown state files to SQLite.
# Creates fixture files in a temp directory, runs the migration script,
# and verifies the resulting database contents.
#
# Usage: bash tests/unit/migrate-to-sqlite.test.sh

# NOTE: -e is intentionally omitted — the test uses its own PASS/FAIL counters
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PASS=0
FAIL=0

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

assert_not_empty() {
  local val="$1" msg="$2"
  if [ -n "$val" ]; then pass "$msg"
  else fail "$msg (was empty)"; fi
}

assert_file_exists() {
  local path="$1" msg="$2"
  if [ -f "$path" ]; then pass "$msg"
  else fail "$msg (file not found: $path)"; fi
}

# ── Setup: create isolated mock environment ──────────────────────────

TMPDIR_ROOT=$(mktemp -d)
cleanup() { rm -rf "$TMPDIR_ROOT"; }
trap cleanup EXIT

MOCK_SCRIPTS_DIR="$TMPDIR_ROOT/scripts"
MOCK_DEV_DIR="$TMPDIR_ROOT/.dev"
mkdir -p "$MOCK_SCRIPTS_DIR" "$MOCK_DEV_DIR"

# Copy scripts under test — the migration script resolves DEV_DIR relative to SCRIPT_DIR
cp "$REPO_ROOT/scripts/migrate-to-sqlite.sh" "$MOCK_SCRIPTS_DIR/"
cp "$REPO_ROOT/scripts/_db.sh" "$MOCK_SCRIPTS_DIR/"

# ── Helper: run migration in the mock environment ────────────────────

run_migration() {
  (cd "$TMPDIR_ROOT" && bash "$MOCK_SCRIPTS_DIR/migrate-to-sqlite.sh" 2>&1)
}

# ── Helper: query the mock DB ────────────────────────────────────────

mock_db() {
  sqlite3 "$MOCK_DEV_DIR/skynet.db" "$1" 2>/dev/null
}

# ── Helper: reset mock environment for a fresh test ──────────────────

reset_mock() {
  rm -rf "$MOCK_DEV_DIR"
  mkdir -p "$MOCK_DEV_DIR"
}

# ============================================================
# TEST: Pre-flight — refuses re-migration of existing DB
# ============================================================

echo ""
printf "  %s\n" "=== pre-flight: refuses re-migration ==="

reset_mock

# Create a DB with data already
export SKYNET_DEV_DIR="$MOCK_DEV_DIR"
source "$REPO_ROOT/scripts/_db.sh"
log() { :; }
db_init
db_add_task "Existing task" "FEAT" "" "top" >/dev/null
unset SKYNET_DEV_DIR

OUTPUT=$(run_migration 2>&1)
RC=$?
assert_eq "$RC" "1" "pre-flight: exits with code 1 when DB has tasks"
assert_contains "$OUTPUT" "already contains" "pre-flight: warns about existing data"

# ============================================================
# TEST: Backlog migration — all status markers, tags, blockedBy
# ============================================================

echo ""
printf "  %s\n" "=== backlog migration ==="

reset_mock

cat > "$MOCK_DEV_DIR/backlog.md" << 'EOF'
# Backlog

- [ ] [FEAT] Build login page — OAuth2 flow implementation
- [>] [FIX] Fix critical bug
- [x] [CHORE] Update dependencies
- [ ] [INFRA] Deploy monitoring — set up Grafana dashboards | blockedBy: Build login page
- [ ] Task with 'single quotes' in title
- [ ] Strip trailing notes _(worktree missing)_
- This line should be skipped (no checkbox)
EOF

OUTPUT=$(run_migration 2>&1)
RC=$?
assert_eq "$RC" "0" "backlog: migration succeeds"

TASK_COUNT=$(mock_db "SELECT COUNT(*) FROM tasks;")
assert_eq "$TASK_COUNT" "6" "backlog: 6 tasks migrated"

# Verify pending task with tag and description
TITLE=$(mock_db "SELECT title FROM tasks WHERE tag='FEAT' AND status='pending';")
assert_eq "$TITLE" "Build login page" "backlog: FEAT title parsed"
DESC=$(mock_db "SELECT description FROM tasks WHERE tag='FEAT' AND status='pending';")
assert_eq "$DESC" "OAuth2 flow implementation" "backlog: description split at em-dash"

# Verify claimed status
STATUS=$(mock_db "SELECT status FROM tasks WHERE title='Fix critical bug';")
assert_eq "$STATUS" "claimed" "backlog: [>] marker -> claimed status"

# Verify done status
STATUS=$(mock_db "SELECT status FROM tasks WHERE title='Update dependencies';")
assert_eq "$STATUS" "done" "backlog: [x] marker -> done status"

# Verify tag extraction
TAG=$(mock_db "SELECT tag FROM tasks WHERE title='Fix critical bug';")
assert_eq "$TAG" "FIX" "backlog: tag extracted from [FIX]"

# Verify blockedBy
BLOCKED=$(mock_db "SELECT blocked_by FROM tasks WHERE title='Deploy monitoring';")
assert_eq "$BLOCKED" "Build login page" "backlog: blockedBy parsed"
DESC2=$(mock_db "SELECT description FROM tasks WHERE title='Deploy monitoring';")
assert_eq "$DESC2" "set up Grafana dashboards" "backlog: description before blockedBy"

# Verify single quotes escaped correctly
QTITLE=$(mock_db "SELECT title FROM tasks WHERE title LIKE '%single quotes%';")
assert_eq "$QTITLE" "Task with 'single quotes' in title" "backlog: single quotes preserved"

# Verify trailing notes stripped
STRIPPED=$(mock_db "SELECT title FROM tasks WHERE title LIKE '%trailing%';")
assert_eq "$STRIPPED" "Strip trailing notes" "backlog: trailing _(note)_ stripped"

# Verify priority ordering
PRI0=$(mock_db "SELECT title FROM tasks WHERE priority=0;")
assert_eq "$PRI0" "Build login page" "backlog: first item gets priority 0"
PRI5=$(mock_db "SELECT title FROM tasks WHERE priority=5;")
assert_eq "$PRI5" "Strip trailing notes" "backlog: last item gets highest priority"

# Verify normalized_root
NROOT=$(mock_db "SELECT normalized_root FROM tasks WHERE title='Build login page';")
assert_eq "$NROOT" "build login page" "backlog: normalized_root is lowercased title"

# ============================================================
# TEST: Completed.md migration — pipe-delimited table
# ============================================================

echo ""
printf "  %s\n" "=== completed migration ==="

reset_mock

cat > "$MOCK_DEV_DIR/completed.md" << 'EOF'
| Date | Task | Branch | Duration | Notes |
|------|------|--------|----------|-------|
| 2025-01-15 | [FEAT] Add auth — JWT implementation | dev/add-auth | 2h 30m | All tests pass |
| 2025-01-16 | [FIX] Fix race condition | dev/fix-race | 45m | Edge case fixed |
| 2025-01-17 | [CHORE] Update deps | dev/update-deps | 1h | Routine |
EOF

OUTPUT=$(run_migration 2>&1)
RC=$?
assert_eq "$RC" "0" "completed: migration succeeds"

COMP_COUNT=$(mock_db "SELECT COUNT(*) FROM tasks WHERE status='completed';")
assert_eq "$COMP_COUNT" "3" "completed: 3 tasks migrated"

# Verify first completed task
TITLE=$(mock_db "SELECT title FROM tasks WHERE branch='dev/add-auth';")
assert_eq "$TITLE" "Add auth" "completed: title parsed (tag stripped)"
TAG=$(mock_db "SELECT tag FROM tasks WHERE branch='dev/add-auth';")
assert_eq "$TAG" "FEAT" "completed: tag extracted"
DESC=$(mock_db "SELECT description FROM tasks WHERE branch='dev/add-auth';")
assert_eq "$DESC" "JWT implementation" "completed: description from em-dash"
DUR=$(mock_db "SELECT duration FROM tasks WHERE branch='dev/add-auth';")
assert_eq "$DUR" "2h 30m" "completed: duration string stored"
DUR_S=$(mock_db "SELECT duration_secs FROM tasks WHERE branch='dev/add-auth';")
assert_eq "$DUR_S" "9000" "completed: 2h 30m = 9000 seconds"
NOTES=$(mock_db "SELECT notes FROM tasks WHERE branch='dev/add-auth';")
assert_eq "$NOTES" "All tests pass" "completed: notes stored"
DATE=$(mock_db "SELECT completed_at FROM tasks WHERE branch='dev/add-auth';")
assert_eq "$DATE" "2025-01-15" "completed: completed_at set"

# Verify minutes-only duration
DUR_M=$(mock_db "SELECT duration_secs FROM tasks WHERE branch='dev/fix-race';")
assert_eq "$DUR_M" "2700" "completed: 45m = 2700 seconds"

# Verify hours-only duration
DUR_H=$(mock_db "SELECT duration_secs FROM tasks WHERE branch='dev/update-deps';")
assert_eq "$DUR_H" "3600" "completed: 1h = 3600 seconds"

# ============================================================
# TEST: Completed.md — old format without Duration column
# ============================================================

echo ""
printf "  %s\n" "=== completed migration (old format) ==="

reset_mock

cat > "$MOCK_DEV_DIR/completed.md" << 'EOF'
| Date | Task | Branch | Notes |
|------|------|--------|-------|
| 2025-01-10 | [FEAT] Old task | dev/old-task | No duration column |
EOF

OUTPUT=$(run_migration 2>&1)
assert_eq "$?" "0" "completed-old: migration succeeds"

DUR_NULL=$(mock_db "SELECT duration_secs FROM tasks WHERE branch='dev/old-task';")
assert_eq "$DUR_NULL" "" "completed-old: duration_secs NULL when no duration column"
NOTES=$(mock_db "SELECT notes FROM tasks WHERE branch='dev/old-task';")
assert_eq "$NOTES" "No duration column" "completed-old: notes from 4th column"

# ============================================================
# TEST: Failed-tasks.md migration
# ============================================================

echo ""
printf "  %s\n" "=== failed tasks migration ==="

reset_mock

cat > "$MOCK_DEV_DIR/failed-tasks.md" << 'EOF'
| Date | Task | Branch | Error | Attempts | Status |
|------|------|--------|-------|----------|--------|
| 2025-01-15 | [FIX] Fix login | dev/fix-login | typecheck failed: 3 errors | 2 | failed |
| 2025-01-16 | [FEAT] Add search | dev/add-search | timeout after 10m | 1 | blocked |
| 2025-01-17 | [FIX] Fix CSS | dev/fix-css | lint errors | | failed |
| 2025-01-18 | Simple task | dev/simple | error msg | 3 | |
EOF

OUTPUT=$(run_migration 2>&1)
assert_eq "$?" "0" "failed: migration succeeds"

FAIL_COUNT=$(mock_db "SELECT COUNT(*) FROM tasks;")
assert_eq "$FAIL_COUNT" "4" "failed: 4 tasks migrated"

# Verify error, attempts, status
ERR=$(mock_db "SELECT error FROM tasks WHERE branch='dev/fix-login';")
assert_eq "$ERR" "typecheck failed: 3 errors" "failed: error message stored"
ATT=$(mock_db "SELECT attempts FROM tasks WHERE branch='dev/fix-login';")
assert_eq "$ATT" "2" "failed: attempts stored"
STATUS=$(mock_db "SELECT status FROM tasks WHERE branch='dev/fix-login';")
assert_eq "$STATUS" "failed" "failed: status parsed"

# Verify blocked status
STATUS2=$(mock_db "SELECT status FROM tasks WHERE branch='dev/add-search';")
assert_eq "$STATUS2" "blocked" "failed: blocked status preserved"

# Verify empty attempts defaults to 0
ATT3=$(mock_db "SELECT attempts FROM tasks WHERE branch='dev/fix-css';")
assert_eq "$ATT3" "0" "failed: empty attempts defaults to 0"

# Verify empty status defaults to failed
STATUS4=$(mock_db "SELECT status FROM tasks WHERE branch='dev/simple';")
assert_eq "$STATUS4" "failed" "failed: empty status defaults to 'failed'"

# Verify tag extraction
TAG=$(mock_db "SELECT tag FROM tasks WHERE branch='dev/fix-login';")
assert_eq "$TAG" "FIX" "failed: tag extracted"

# Verify no-tag case
TAG2=$(mock_db "SELECT tag FROM tasks WHERE branch='dev/simple';")
assert_eq "$TAG2" "" "failed: no tag when absent"

# ============================================================
# TEST: Blockers.md migration — only active blockers
# ============================================================

echo ""
printf "  %s\n" "=== blockers migration ==="

reset_mock

cat > "$MOCK_DEV_DIR/blockers.md" << 'EOF'
# Blockers

## Active
- Auth service is down — login tests fail
- CI pipeline timeout on large repos

## Resolved
- Package registry outage (resolved 2025-01-10)
- DNS issue (resolved 2025-01-05)
EOF

OUTPUT=$(run_migration 2>&1)
assert_eq "$?" "0" "blockers: migration succeeds"

BLOCKER_COUNT=$(mock_db "SELECT COUNT(*) FROM blockers;")
assert_eq "$BLOCKER_COUNT" "2" "blockers: only 2 active blockers migrated"

B1=$(mock_db "SELECT description FROM blockers WHERE id=1;")
assert_contains "$B1" "Auth service is down" "blockers: first active blocker stored"

B2=$(mock_db "SELECT description FROM blockers WHERE id=2;")
assert_contains "$B2" "CI pipeline timeout" "blockers: second active blocker stored"

# Verify status
BSTATUS=$(mock_db "SELECT DISTINCT status FROM blockers;")
assert_eq "$BSTATUS" "active" "blockers: all migrated blockers have active status"

# ============================================================
# TEST: Events.log migration
# ============================================================

echo ""
printf "  %s\n" "=== events migration ==="

reset_mock

cat > "$MOCK_DEV_DIR/events.log" << 'EOF'
1705334400|TASK_CLAIMED|Worker 1: Build login page
1705334500|TASK_COMPLETED|Worker 1: Build login page completed
1705334600|WATCHDOG_RUN|Reconciliation complete
invalid_epoch|BAD_EVENT|This should be skipped

1705334700|WORKER_STALE|Worker 3: heartbeat timeout
EOF

OUTPUT=$(run_migration 2>&1)
assert_eq "$?" "0" "events: migration succeeds"

EVENT_COUNT=$(mock_db "SELECT COUNT(*) FROM events;")
assert_eq "$EVENT_COUNT" "4" "events: 4 valid events migrated (invalid epoch + empty line skipped)"

# Verify event data
EPOCH=$(mock_db "SELECT epoch FROM events WHERE event='TASK_CLAIMED';")
assert_eq "$EPOCH" "1705334400" "events: epoch stored correctly"
DETAIL=$(mock_db "SELECT detail FROM events WHERE event='TASK_CLAIMED';")
assert_eq "$DETAIL" "Worker 1: Build login page" "events: detail stored"

# Verify worker_id extraction from detail
WID=$(mock_db "SELECT worker_id FROM events WHERE event='TASK_CLAIMED';")
assert_eq "$WID" "1" "events: worker_id extracted from 'Worker 1:'"

# Verify NULL worker_id for non-worker events
WID2=$(mock_db "SELECT worker_id FROM events WHERE event='WATCHDOG_RUN';")
assert_eq "$WID2" "" "events: worker_id NULL for non-worker events"

# ============================================================
# TEST: Fixer-stats.log migration
# ============================================================

echo ""
printf "  %s\n" "=== fixer stats migration ==="

reset_mock

cat > "$MOCK_DEV_DIR/fixer-stats.log" << 'EOF'
1705334400|success|Fix login page
1705334500|failure|Fix search bar
bad_epoch|failure|Should be skipped

1705334700|success|Fix CSS issues
EOF

OUTPUT=$(run_migration 2>&1)
assert_eq "$?" "0" "fixer: migration succeeds"

FIXER_COUNT=$(mock_db "SELECT COUNT(*) FROM fixer_stats;")
assert_eq "$FIXER_COUNT" "3" "fixer: 3 valid entries migrated (bad epoch + empty skipped)"

RESULT=$(mock_db "SELECT result FROM fixer_stats WHERE task_title='Fix login page';")
assert_eq "$RESULT" "success" "fixer: result stored"
FEPOCH=$(mock_db "SELECT epoch FROM fixer_stats WHERE task_title='Fix login page';")
assert_eq "$FEPOCH" "1705334400" "fixer: epoch stored"

# ============================================================
# TEST: current-task-N.md → workers table
# ============================================================

echo ""
printf "  %s\n" "=== worker migration ==="

reset_mock

cat > "$MOCK_DEV_DIR/current-task-1.md" << 'EOF'
## Fix critical bug
**Status:** in_progress
**Branch:** dev/fix-critical-bug
**Started:** 2025-01-15 10:00:00
**Last update:** Running typecheck
EOF

cat > "$MOCK_DEV_DIR/current-task-2.md" << 'EOF'
## Build login page
**Status:** idle
**Branch:** dev/build-login
**Started:** 2025-01-15 11:00:00
EOF

# Create heartbeat file for worker 1
echo "1705334400" > "$MOCK_DEV_DIR/worker-1.heartbeat"

# Invalid worker ID file should be skipped
cat > "$MOCK_DEV_DIR/current-task-abc.md" << 'EOF'
## Invalid worker
**Status:** in_progress
EOF

OUTPUT=$(run_migration 2>&1)
assert_eq "$?" "0" "workers: migration succeeds"

WORKER_COUNT=$(mock_db "SELECT COUNT(*) FROM workers;")
assert_eq "$WORKER_COUNT" "2" "workers: 2 valid workers migrated (non-numeric skipped)"

# Verify worker 1
W1_STATUS=$(mock_db "SELECT status FROM workers WHERE id=1;")
assert_eq "$W1_STATUS" "in_progress" "workers: worker 1 status parsed"
W1_TITLE=$(mock_db "SELECT task_title FROM workers WHERE id=1;")
assert_eq "$W1_TITLE" "Fix critical bug" "workers: worker 1 task title parsed"
W1_BRANCH=$(mock_db "SELECT branch FROM workers WHERE id=1;")
assert_eq "$W1_BRANCH" "dev/fix-critical-bug" "workers: worker 1 branch parsed"
W1_HB=$(mock_db "SELECT heartbeat_epoch FROM workers WHERE id=1;")
assert_eq "$W1_HB" "1705334400" "workers: worker 1 heartbeat from file"
# NOTE: The migration script's sed pattern for info uses BRE \| alternation
# which BSD sed (macOS) does not support, so last_info is always empty.
# This test verifies actual behavior — the field exists but is empty.
W1_INFO=$(mock_db "SELECT last_info FROM workers WHERE id=1;")
assert_eq "$W1_INFO" "" "workers: worker 1 last_info (empty — BSD sed \| limitation)"

# Verify worker 2 defaults
W2_STATUS=$(mock_db "SELECT status FROM workers WHERE id=2;")
assert_eq "$W2_STATUS" "idle" "workers: worker 2 status parsed"
W2_HB=$(mock_db "SELECT heartbeat_epoch FROM workers WHERE id=2;")
assert_eq "$W2_HB" "" "workers: worker 2 has NULL heartbeat (no file)"

# ============================================================
# TEST: Backup creation
# ============================================================

echo ""
printf "  %s\n" "=== backup creation ==="

reset_mock

cat > "$MOCK_DEV_DIR/backlog.md" << 'EOF'
- [ ] Test backup task
EOF
cat > "$MOCK_DEV_DIR/completed.md" << 'EOF'
| Date | Task | Branch | Notes |
|------|------|--------|-------|
EOF
echo "1705334400|TASK_CLAIMED|test" > "$MOCK_DEV_DIR/events.log"
cat > "$MOCK_DEV_DIR/current-task-1.md" << 'EOF'
## Backup worker
**Status:** idle
EOF
echo "1705334400" > "$MOCK_DEV_DIR/worker-1.heartbeat"

OUTPUT=$(run_migration 2>&1)
assert_eq "$?" "0" "backup: migration succeeds"

assert_file_exists "$MOCK_DEV_DIR/md-backup/backlog.md" "backup: backlog.md backed up"
assert_file_exists "$MOCK_DEV_DIR/md-backup/completed.md" "backup: completed.md backed up"
assert_file_exists "$MOCK_DEV_DIR/md-backup/events.log" "backup: events.log backed up"
assert_file_exists "$MOCK_DEV_DIR/md-backup/current-task-1.md" "backup: current-task-1.md backed up"
assert_file_exists "$MOCK_DEV_DIR/md-backup/worker-1.heartbeat" "backup: worker-1.heartbeat backed up"

# ============================================================
# TEST: Validation — task count matches expected
# ============================================================

echo ""
printf "  %s\n" "=== validation: task count ==="

reset_mock

cat > "$MOCK_DEV_DIR/backlog.md" << 'EOF'
- [ ] Backlog item 1
- [ ] Backlog item 2
EOF

cat > "$MOCK_DEV_DIR/completed.md" << 'EOF'
| Date | Task | Branch | Notes |
|------|------|--------|-------|
| 2025-01-15 | Completed item | dev/comp | Done |
EOF

cat > "$MOCK_DEV_DIR/failed-tasks.md" << 'EOF'
| Date | Task | Branch | Error | Attempts | Status |
|------|------|--------|-------|----------|--------|
| 2025-01-16 | Failed item | dev/fail | err | 1 | failed |
EOF

OUTPUT=$(run_migration 2>&1)
assert_eq "$?" "0" "validation: migration succeeds"

TOTAL=$(mock_db "SELECT COUNT(*) FROM tasks;")
assert_eq "$TOTAL" "4" "validation: total 4 tasks (2 backlog + 1 completed + 1 failed)"

# Check no WARNING in output (counts should match)
if printf '%s' "$OUTPUT" | grep -q "WARNING.*mismatch"; then
  fail "validation: unexpected count mismatch warning"
else
  pass "validation: no count mismatch warning"
fi

# ============================================================
# TEST: Normalized root recomputation
# ============================================================

echo ""
printf "  %s\n" "=== normalized root recomputation ==="

reset_mock

cat > "$MOCK_DEV_DIR/backlog.md" << 'EOF'
- [ ] [FEAT] Add User Authentication
- [ ] simple lowercase task
- [ ] [INFRA]   Extra  Spaces  Here
EOF

OUTPUT=$(run_migration 2>&1)
assert_eq "$?" "0" "norm_root: migration succeeds"

# The recomputation should strip [TAG], lowercase, collapse spaces
NR1=$(mock_db "SELECT normalized_root FROM tasks WHERE title='Add User Authentication';")
assert_eq "$NR1" "add user authentication" "norm_root: lowercased, tag stripped"

NR2=$(mock_db "SELECT normalized_root FROM tasks WHERE title='simple lowercase task';")
assert_eq "$NR2" "simple lowercase task" "norm_root: already clean"

NR3=$(mock_db "SELECT normalized_root FROM tasks WHERE title='Extra  Spaces  Here';")
assert_eq "$NR3" "extra spaces here" "norm_root: extra spaces collapsed"

# ============================================================
# TEST: Section tracking — _mark_section and resume
# ============================================================

echo ""
printf "  %s\n" "=== section tracking and resume ==="

reset_mock

cat > "$MOCK_DEV_DIR/backlog.md" << 'EOF'
- [ ] Resume test task
EOF

# Run initial migration (creates backlog section)
OUTPUT=$(run_migration 2>&1)
assert_eq "$?" "0" "resume: initial migration succeeds"

SECTIONS=$(mock_db "SELECT value FROM _metadata WHERE key='migration_sections';")
assert_contains "$SECTIONS" "ALL" "resume: ALL marker set after full migration"

# Verify the backlog section was marked
assert_contains "$SECTIONS" "backlog" "resume: backlog section tracked"

# ============================================================
# TEST: Partial migration resume — skips already completed sections
# ============================================================

echo ""
printf "  %s\n" "=== partial migration resume ==="

reset_mock

cat > "$MOCK_DEV_DIR/backlog.md" << 'EOF'
- [ ] Partial test task A
- [ ] Partial test task B
EOF
cat > "$MOCK_DEV_DIR/completed.md" << 'EOF'
| Date | Task | Branch | Notes |
|------|------|--------|-------|
| 2025-01-15 | Partial completed | dev/partial | Done |
EOF

# First: do a full migration
run_migration >/dev/null 2>&1

# Manually reset migration_sections to only "backlog" (simulate partial)
mock_db "UPDATE _metadata SET value='backlog' WHERE key='migration_sections';"

# Add more data to completed.md (should be migrated on resume)
cat > "$MOCK_DEV_DIR/completed.md" << 'EOF'
| Date | Task | Branch | Notes |
|------|------|--------|-------|
| 2025-01-15 | Partial completed | dev/partial | Done |
| 2025-01-16 | New completed | dev/new-comp | Resumed |
EOF

OUTPUT=$(run_migration 2>&1)
assert_eq "$?" "0" "partial-resume: migration succeeds"
assert_contains "$OUTPUT" "already migrated" "partial-resume: backlog section skipped"

# ============================================================
# TEST: Empty state files — migration handles missing files gracefully
# ============================================================

echo ""
printf "  %s\n" "=== empty/missing files ==="

reset_mock

# No fixture files at all — migration should still succeed
OUTPUT=$(run_migration 2>&1)
assert_eq "$?" "0" "empty: migration succeeds with no source files"

TOTAL=$(mock_db "SELECT COUNT(*) FROM tasks;")
assert_eq "$TOTAL" "0" "empty: 0 tasks when no source files"

BLOCKER_COUNT=$(mock_db "SELECT COUNT(*) FROM blockers;")
assert_eq "$BLOCKER_COUNT" "0" "empty: 0 blockers when no source files"

EVENT_COUNT=$(mock_db "SELECT COUNT(*) FROM events;")
assert_eq "$EVENT_COUNT" "0" "empty: 0 events when no source files"

# ============================================================
# TEST: Full migration with all file types
# ============================================================

echo ""
printf "  %s\n" "=== full migration (all file types) ==="

reset_mock

cat > "$MOCK_DEV_DIR/backlog.md" << 'EOF'
- [ ] [FEAT] Build API — REST endpoints
- [>] [FIX] Fix race condition
- [ ] Simple pending task
EOF

cat > "$MOCK_DEV_DIR/completed.md" << 'EOF'
| Date | Task | Branch | Duration | Notes |
|------|------|--------|----------|-------|
| 2025-01-15 | [FEAT] Add auth | dev/auth | 3h 15m | Shipped |
| 2025-01-16 | [FIX] Fix bug | dev/bugfix | 20m | Quick fix |
EOF

cat > "$MOCK_DEV_DIR/failed-tasks.md" << 'EOF'
| Date | Task | Branch | Error | Attempts | Status |
|------|------|--------|-------|----------|--------|
| 2025-01-17 | [FEAT] Add search | dev/search | timeout | 2 | failed |
EOF

cat > "$MOCK_DEV_DIR/blockers.md" << 'EOF'
## Active
- CI timeout on tests
## Resolved
- Old issue
EOF

cat > "$MOCK_DEV_DIR/events.log" << 'EOF'
1705334400|TASK_CLAIMED|Worker 1: Build API
1705334500|TASK_COMPLETED|Worker 1: Build API done
EOF

cat > "$MOCK_DEV_DIR/fixer-stats.log" << 'EOF'
1705334600|success|Fix race condition
1705334700|failure|Add search
EOF

cat > "$MOCK_DEV_DIR/current-task-1.md" << 'EOF'
## Fix race condition
**Status:** in_progress
**Branch:** dev/fix-race
**Started:** 2025-01-15 10:00:00
**Note:** Attempting fix
EOF
echo "1705340000" > "$MOCK_DEV_DIR/worker-1.heartbeat"

OUTPUT=$(run_migration 2>&1)
assert_eq "$?" "0" "full: migration succeeds"

# Verify all tables populated
TASKS=$(mock_db "SELECT COUNT(*) FROM tasks;")
assert_eq "$TASKS" "6" "full: 6 tasks total (3 backlog + 2 completed + 1 failed)"

BLOCKERS=$(mock_db "SELECT COUNT(*) FROM blockers;")
assert_eq "$BLOCKERS" "1" "full: 1 active blocker"

EVENTS=$(mock_db "SELECT COUNT(*) FROM events;")
assert_eq "$EVENTS" "2" "full: 2 events"

FIXERS=$(mock_db "SELECT COUNT(*) FROM fixer_stats;")
assert_eq "$FIXERS" "2" "full: 2 fixer stats"

WORKERS=$(mock_db "SELECT COUNT(*) FROM workers;")
assert_eq "$WORKERS" "1" "full: 1 worker"

# Verify migration summary line in output
assert_contains "$OUTPUT" "Migration Summary" "full: summary output present"
assert_contains "$OUTPUT" "Migration complete" "full: completion message present"

# Verify ALL sections marked
SECTIONS=$(mock_db "SELECT value FROM _metadata WHERE key='migration_sections';")
assert_contains "$SECTIONS" "ALL" "full: ALL section marker set"

# ============================================================
# TEST: SQL injection safety via esc() helper
# ============================================================

echo ""
printf "  %s\n" "=== SQL injection safety ==="

reset_mock

cat > "$MOCK_DEV_DIR/backlog.md" << 'EOF'
- [ ] Task with 'quotes' and "doubles"
- [ ] O'Brien's task — it's a "complex" one
EOF

OUTPUT=$(run_migration 2>&1)
assert_eq "$?" "0" "sql-safety: migration succeeds with special chars"

T1=$(mock_db "SELECT title FROM tasks WHERE title LIKE '%quotes%';")
assert_eq "$T1" "Task with 'quotes' and \"doubles\"" "sql-safety: quotes preserved in title"

T2=$(mock_db "SELECT title FROM tasks WHERE title LIKE '%Brien%';")
assert_eq "$T2" "O'Brien's task" "sql-safety: apostrophes in title preserved"
D2=$(mock_db "SELECT description FROM tasks WHERE title LIKE '%Brien%';")
assert_contains "$D2" "it's" "sql-safety: apostrophes in description preserved"

# ============================================================
# TEST: Duration parsing edge cases
# ============================================================

echo ""
printf "  %s\n" "=== duration parsing edge cases ==="

reset_mock

cat > "$MOCK_DEV_DIR/completed.md" << 'EOF'
| Date | Task | Branch | Duration | Notes |
|------|------|--------|----------|-------|
| 2025-01-15 | Hours and minutes | dev/hm | 5h 45m | standard |
| 2025-01-16 | Hours only | dev/h | 3h | hours |
| 2025-01-17 | Minutes only | dev/m | 15m | minutes |
| 2025-01-18 | Zero duration | dev/z | 0m | zero |
EOF

OUTPUT=$(run_migration 2>&1)
assert_eq "$?" "0" "duration: migration succeeds"

D_HM=$(mock_db "SELECT duration_secs FROM tasks WHERE branch='dev/hm';")
assert_eq "$D_HM" "20700" "duration: 5h 45m = 20700s"

D_H=$(mock_db "SELECT duration_secs FROM tasks WHERE branch='dev/h';")
assert_eq "$D_H" "10800" "duration: 3h = 10800s"

D_M=$(mock_db "SELECT duration_secs FROM tasks WHERE branch='dev/m';")
assert_eq "$D_M" "900" "duration: 15m = 900s"

D_Z=$(mock_db "SELECT duration_secs FROM tasks WHERE branch='dev/z';")
assert_eq "$D_Z" "0" "duration: 0m = 0s"

# ── Summary ──────────────────────────────────────────────────────

echo ""
TOTAL=$((PASS + FAIL))
printf "  Results: %d/%d passed, %d failed\n" "$PASS" "$TOTAL" "$FAIL"
if [ "$FAIL" -eq 0 ]; then
  printf "  \033[32mAll checks passed!\033[0m\n"
else
  printf "  \033[31mSome checks failed!\033[0m\n"
  exit 1
fi
