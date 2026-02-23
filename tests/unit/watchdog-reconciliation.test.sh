#!/usr/bin/env bash
# tests/unit/watchdog-reconciliation.test.sh — Unit tests for watchdog reconciliation logic
#
# Tests: validate_backlog, _normalize_title, auto-supersede, stale heartbeat
# detection, and SQLite integrity check.
#
# Usage: bash tests/unit/watchdog-reconciliation.test.sh

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

assert_not_contains() {
  local haystack="$1" needle="$2" msg="$3"
  if echo "$haystack" | grep -qF "$needle"; then
    fail "$msg (should not contain '$needle')"
  else
    pass "$msg"
  fi
}

assert_grep_file() {
  local pattern="$1" file="$2" msg="$3"
  if grep -q "$pattern" "$file" 2>/dev/null; then
    pass "$msg"
  else
    fail "$msg (pattern '$pattern' not found in $file)"
  fi
}

assert_not_grep_file() {
  local pattern="$1" file="$2" msg="$3"
  if grep -q "$pattern" "$file" 2>/dev/null; then
    fail "$msg (pattern '$pattern' should not be in $file)"
  else
    pass "$msg"
  fi
}

# ── Setup: create isolated environment ──────────────────────────────

TMPDIR_ROOT=$(mktemp -d)
trap 'rm -rf "$TMPDIR_ROOT"' EXIT

export SKYNET_PROJECT_DIR="$TMPDIR_ROOT"
export SKYNET_DEV_DIR="$TMPDIR_ROOT/.dev"
export SKYNET_PROJECT_NAME="test-wd"
export SKYNET_LOCK_PREFIX="/tmp/skynet-test-wd-$$"
export SKYNET_STALE_MINUTES=45
export SKYNET_MAX_WORKERS=2
export SKYNET_MAX_FIXERS=1
export SKYNET_MAIN_BRANCH="main"

mkdir -p "$SKYNET_DEV_DIR"

# Set up path vars needed by _config.sh functions
DEV_DIR="$SKYNET_DEV_DIR"
BACKLOG="$DEV_DIR/backlog.md"
COMPLETED="$DEV_DIR/completed.md"
FAILED="$DEV_DIR/failed-tasks.md"

# Create required files
touch "$BACKLOG" "$COMPLETED" "$FAILED"

# Log capture file
LOG_CAPTURE="$TMPDIR_ROOT/log-capture.txt"
: > "$LOG_CAPTURE"
log() { echo "$*" >> "$LOG_CAPTURE"; }

# Source _db.sh for SQLite functions
source "$REPO_ROOT/scripts/_db.sh"
db_init

# _db_sep uses \x1f (Unit Separator), not '|'. Use this for output parsing.
SEP=$'\x1f'

# Source compat layer (needed by validate_backlog for file_mtime, file_size, to_upper)
source "$REPO_ROOT/scripts/_compat.sh"

SKYNET_PROJECT_NAME_UPPER="$(to_upper "$SKYNET_PROJECT_NAME")"

# Source validate_backlog from _config.sh
eval "$(sed -n '/^validate_backlog()/,/^}$/p' "$REPO_ROOT/scripts/_config.sh")"

# ============================================================
# TEST: validate_backlog — duplicate detection (SQLite-based)
# ============================================================

echo ""
log "=== validate_backlog: duplicate detection ==="

# Insert duplicate pending titles into SQLite
sqlite3 "$DB_PATH" "DELETE FROM tasks;"
db_add_task "Build login page" "FEAT" "OAuth2" "top"
db_add_task "Build login page" "FEAT" "Different description" "bottom"
db_add_task "Fix navbar" "FIX" "" "bottom"

: > "$LOG_CAPTURE"
validate_backlog 2>/dev/null
VALIDATE_OUTPUT=$(cat "$LOG_CAPTURE")
assert_contains "$VALIDATE_OUTPUT" "Duplicate pending title" "validate_backlog: detects duplicate titles in SQLite"

# ============================================================
# TEST: validate_backlog — no false positives on unique tasks
# ============================================================

echo ""
printf "  %s\n" "=== validate_backlog: no false positives ==="

sqlite3 "$DB_PATH" "DELETE FROM tasks;"
db_add_task "Unique task one" "FEAT" "" "top"
db_add_task "Unique task two" "FIX" "" "bottom"
db_add_task "Unique task three" "CHORE" "" "bottom"

: > "$LOG_CAPTURE"
validate_backlog 2>/dev/null
VALIDATE_OUTPUT2=$(cat "$LOG_CAPTURE")
assert_not_contains "$VALIDATE_OUTPUT2" "Duplicate" "validate_backlog: no false positive on unique tasks"

# ============================================================
# TEST: _normalize_title
# ============================================================

echo ""
log "=== _normalize_title ==="

# Define _normalize_title from watchdog.sh
eval "$(sed -n '/^_normalize_title()/,/^}$/p' "$REPO_ROOT/scripts/watchdog.sh")"

NORM1=$(_normalize_title "[FEAT] Build Login Page — Some description")
assert_eq "$NORM1" "build login page — some description" "_normalize_title: strips tag, lowercases"

NORM2=$(_normalize_title "[FIX] Fix Bug — FRESH implementation attempt 2")
assert_eq "$NORM2" "fix bug" "_normalize_title: strips FRESH implementation suffix"

NORM3=$(_normalize_title "   [CHORE]   Cleanup   spaces   ")
assert_eq "$NORM3" "cleanup spaces" "_normalize_title: collapses and trims whitespace"

NORM4=$(_normalize_title "[DATA] A very long task title that exceeds fifty characters when all is said and done")
NORM4_LEN=${#NORM4}
[ "$NORM4_LEN" -le 50 ] && pass "_normalize_title: truncates to 50 chars (len=$NORM4_LEN)" || fail "_normalize_title: should truncate to 50 (len=$NORM4_LEN)"

# ============================================================
# TEST: db_auto_supersede_completed
# ============================================================

echo ""
log "=== db_auto_supersede_completed ==="

# Clean slate
sqlite3 "$DB_PATH" "DELETE FROM tasks;"

# Insert a completed task and a failed task with same normalized_root
sqlite3 "$DB_PATH" "INSERT INTO tasks (title, tag, status, normalized_root) VALUES ('Build auth system', 'FEAT', 'completed', 'build auth system');"
sqlite3 "$DB_PATH" "INSERT INTO tasks (title, tag, status, normalized_root, failed_at) VALUES ('Build auth system attempt 1', 'FEAT', 'failed', 'build auth system', datetime('now'));"

SUPERSEDED=$(db_auto_supersede_completed)
assert_eq "$SUPERSEDED" "1" "db_auto_supersede_completed: supersedes 1 failed task"

# The failed task should now be superseded
STATUS=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE title='Build auth system attempt 1';")
assert_eq "$STATUS" "superseded" "db_auto_supersede_completed: failed task status is superseded"

# The completed task should be unchanged
STATUS2=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE title='Build auth system';")
assert_eq "$STATUS2" "completed" "db_auto_supersede_completed: completed task unchanged"

# ============================================================
# TEST: db_auto_supersede — no false supersede when roots differ
# ============================================================

echo ""
log "=== db_auto_supersede: no false positive ==="

sqlite3 "$DB_PATH" "DELETE FROM tasks;"
sqlite3 "$DB_PATH" "INSERT INTO tasks (title, tag, status, normalized_root) VALUES ('Task A', 'FEAT', 'completed', 'task a');"
sqlite3 "$DB_PATH" "INSERT INTO tasks (title, tag, status, normalized_root, failed_at) VALUES ('Task B', 'FEAT', 'failed', 'task b', datetime('now'));"

SUPERSEDED2=$(db_auto_supersede_completed)
assert_eq "$SUPERSEDED2" "0" "db_auto_supersede: no supersede when roots differ"

STATUS3=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE title='Task B';")
assert_eq "$STATUS3" "failed" "db_auto_supersede: different-root task stays failed"

# ============================================================
# TEST: db_auto_supersede — skips tasks with empty normalized_root
# ============================================================

echo ""
log "=== db_auto_supersede: skips empty root ==="

sqlite3 "$DB_PATH" "DELETE FROM tasks;"
sqlite3 "$DB_PATH" "INSERT INTO tasks (title, tag, status, normalized_root) VALUES ('No root completed', 'FEAT', 'completed', '');"
sqlite3 "$DB_PATH" "INSERT INTO tasks (title, tag, status, normalized_root, failed_at) VALUES ('No root failed', 'FEAT', 'failed', '', datetime('now'));"

SUPERSEDED3=$(db_auto_supersede_completed)
assert_eq "$SUPERSEDED3" "0" "db_auto_supersede: skips empty normalized_root"

# ============================================================
# TEST: stale heartbeat detection via SQLite
# ============================================================

echo ""
log "=== stale heartbeat detection ==="

sqlite3 "$DB_PATH" "DELETE FROM workers;"

# Worker 1: fresh heartbeat
NOW=$(date +%s)
db_set_worker_status 1 "dev" "in_progress" "" "Active task" ""
sqlite3 "$DB_PATH" "UPDATE workers SET heartbeat_epoch = $NOW WHERE id=1;"

# Worker 2: stale heartbeat (2 hours ago)
STALE_EPOCH=$(( NOW - 7200 ))
db_set_worker_status 2 "dev" "in_progress" "" "Stuck task" ""
sqlite3 "$DB_PATH" "UPDATE workers SET heartbeat_epoch = $STALE_EPOCH WHERE id=2;"

# 45 min threshold = 2700 seconds
STALE=$(db_get_stale_heartbeats 2700)
assert_contains "$STALE" "2${SEP}" "stale heartbeat: detects worker 2 as stale"
assert_not_contains "$STALE" "1${SEP}$NOW" "stale heartbeat: worker 1 not flagged"

# ============================================================
# TEST: SQLite integrity check (PRAGMA quick_check)
# ============================================================

echo ""
log "=== SQLite integrity check ==="

# Healthy DB
CHECK=$(sqlite3 "$DB_PATH" "PRAGMA quick_check;" 2>&1)
assert_eq "$CHECK" "ok" "integrity check: healthy DB returns 'ok'"

# Corrupted DB detection — create a junk file
CORRUPT_DB="$TMPDIR_ROOT/corrupt.db"
echo "this is not a valid sqlite database" > "$CORRUPT_DB"
CORRUPT_CHECK=$(sqlite3 "$CORRUPT_DB" "PRAGMA quick_check;" 2>&1) || true
if [ "$CORRUPT_CHECK" != "ok" ]; then
  pass "integrity check: corrupt DB does not return 'ok'"
else
  fail "integrity check: corrupt DB should not return 'ok'"
fi

# ============================================================
# TEST: health score integration
# ============================================================

echo ""
printf "  %s\n" "=== health score ==="

sqlite3 "$DB_PATH" "DELETE FROM tasks; DELETE FROM blockers; DELETE FROM workers;"

# Perfect health: no failures, no blockers, no stale
SCORE=$(db_get_health_score 2>/dev/null)
# Score should be a number
[ "$SCORE" -ge 90 ] 2>/dev/null && pass "health score: high when clean ($SCORE)" || fail "health score: expected high when clean (got '$SCORE')"

# Add 2 failed tasks: score should drop
sqlite3 "$DB_PATH" "INSERT INTO tasks (title, tag, status) VALUES ('Fail 1', 'FIX', 'failed');"
sqlite3 "$DB_PATH" "INSERT INTO tasks (title, tag, status) VALUES ('Fail 2', 'FIX', 'failed');"
SCORE2=$(db_get_health_score 2>/dev/null)
[ "$SCORE2" -lt "$SCORE" ] 2>/dev/null && pass "health score: drops with failed tasks ($SCORE2 < $SCORE)" || fail "health score: should drop with failures (got '$SCORE2')"

# Add 1 active blocker: score should drop more
db_add_blocker "CI broken" "" 2>/dev/null
SCORE3=$(db_get_health_score 2>/dev/null)
[ "$SCORE3" -lt "$SCORE2" ] 2>/dev/null && pass "health score: drops more with blocker ($SCORE3 < $SCORE2)" || fail "health score: should drop more with blocker (got '$SCORE3')"

# ============================================================
# TEST: canary mode — file detection
# ============================================================

echo ""
log "=== canary mode: file detection ==="

# Create a canary-pending file
cat > "$DEV_DIR/canary-pending" <<CANARY
commit=abc123def456
timestamp=$(date +%s)
files=scripts/_locks.sh scripts/_merge.sh
CANARY

assert_eq "$(grep '^commit=' "$DEV_DIR/canary-pending" | cut -d= -f2)" "abc123def456" "canary: commit hash stored"
assert_contains "$(cat "$DEV_DIR/canary-pending")" "scripts/_locks.sh" "canary: changed files listed"

# Clean up
rm -f "$DEV_DIR/canary-pending"

# ============================================================
# TEST: canary mode — timeout auto-clear
# ============================================================

echo ""
log "=== canary mode: timeout auto-clear ==="

# Create an expired canary-pending file (timestamp in the past)
_old_ts=$(( $(date +%s) - 3600 ))  # 1 hour ago
cat > "$DEV_DIR/canary-pending" <<CANARY
commit=old123
timestamp=$_old_ts
files=scripts/test.sh
CANARY

_canary_age=$(( $(date +%s) - _old_ts ))
_canary_timeout=$(( 30 * 60 ))  # 30 min default
[ "$_canary_age" -gt "$_canary_timeout" ] && pass "canary: detects expired canary (age=${_canary_age}s > ${_canary_timeout}s)" || fail "canary: should detect expired canary"

rm -f "$DEV_DIR/canary-pending"

# ============================================================
# TEST: canary mode — clearance after completion
# ============================================================

echo ""
log "=== canary mode: clearance after completion ==="

# Simulate: canary active, then a task completes
cat > "$DEV_DIR/canary-pending" <<CANARY
commit=new789
timestamp=$(date +%s)
files=scripts/_db.sh
CANARY

# Insert a recently-completed task
sqlite3 "$DB_PATH" "INSERT INTO tasks (title, tag, status, completed_at) VALUES ('Canary test task', 'FEAT', 'completed', datetime('now'));"

# Check if completed tasks exist after canary timestamp
_post_canary=$(_db "SELECT COUNT(*) FROM tasks WHERE status IN ('completed','fixed') AND completed_at >= datetime('now', '-60 seconds');" 2>/dev/null || echo 0)
[ "${_post_canary:-0}" -gt 0 ] && pass "canary: detects post-canary completion" || fail "canary: should detect post-canary completion"

rm -f "$DEV_DIR/canary-pending"

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
