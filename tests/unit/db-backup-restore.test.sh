#!/usr/bin/env bash
# tests/unit/db-backup-restore.test.sh — Validates SQLite backup + restore flow
#
# Usage: bash tests/unit/db-backup-restore.test.sh
# Creates a temp directory with isolated SQLite DB, validates that:
# 1. A backup created via sqlite3 .backup is a faithful copy
# 2. After corruption, the backup can be restored
# 3. Restored data matches the original

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

assert_not_empty() {
  local val="$1" msg="$2"
  if [ -n "$val" ]; then
    pass "$msg"
  else
    fail "$msg (was empty)"
  fi
}

# ── Setup: create isolated environment ──────────────────────────────

TMPDIR_ROOT=$(mktemp -d)
trap 'rm -rf "$TMPDIR_ROOT"' EXIT

# Minimal config stubs required by _db.sh
export SKYNET_PROJECT_DIR="$TMPDIR_ROOT"
export SKYNET_DEV_DIR="$TMPDIR_ROOT/.dev"
export SKYNET_PROJECT_NAME="test-backup"
export SKYNET_LOCK_PREFIX="/tmp/skynet-test-backup"
export SKYNET_STALE_MINUTES=45
export SKYNET_MAX_WORKERS=4
export SKYNET_MAIN_BRANCH="main"

mkdir -p "$SKYNET_DEV_DIR"

# Provide a stub log() function (required by _db.sh helpers)
log() { :; }

# Source _db.sh directly (it only needs $SKYNET_DEV_DIR)
source "$REPO_ROOT/scripts/_db.sh"

# Restore the test log function
log()  { printf "  %s\n" "$*"; }

# ── Test: Create DB with known data ─────────────────────────────────

echo ""
log "=== Create test DB with known data ==="

db_init
[ -f "$DB_PATH" ] && pass "db_init: creates skynet.db" || fail "db_init: creates skynet.db"

# Insert known tasks
TASK1_ID=$(db_add_task "Backup test task 1" "FEAT" "First task for backup test" "top")
TASK2_ID=$(db_add_task "Backup test task 2" "FIX" "Second task for backup test" "bottom")
TASK3_ID=$(db_add_task "Backup test task 3" "CHORE" "Third task for backup test" "bottom")

assert_not_empty "$TASK1_ID" "Task 1 created"
assert_not_empty "$TASK2_ID" "Task 2 created"
assert_not_empty "$TASK3_ID" "Task 3 created"

# Add events and blockers for additional data integrity verification
db_add_event "TEST_EVENT" "Backup verification event" "1"
db_add_blocker "Test blocker for backup" "Backup test task 1"

# Record expected counts before backup
ORIG_TASK_COUNT=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM tasks;")
ORIG_EVENT_COUNT=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM events;")
ORIG_BLOCKER_COUNT=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM blockers;")
ORIG_TASK1_TITLE=$(sqlite3 "$DB_PATH" "SELECT title FROM tasks WHERE id=$TASK1_ID;")
ORIG_TASK2_TITLE=$(sqlite3 "$DB_PATH" "SELECT title FROM tasks WHERE id=$TASK2_ID;")
ORIG_TASK3_DESC=$(sqlite3 "$DB_PATH" "SELECT description FROM tasks WHERE id=$TASK3_ID;")

assert_eq "$ORIG_TASK_COUNT" "3" "Original DB has 3 tasks"
assert_eq "$ORIG_EVENT_COUNT" "1" "Original DB has 1 event"
assert_eq "$ORIG_BLOCKER_COUNT" "1" "Original DB has 1 blocker"

# ── Test: Create backup via sqlite3 .backup ──────────────────────────

echo ""
log "=== Create backup ==="

BACKUP_PATH="$TMPDIR_ROOT/skynet.db.backup"
sqlite3 "$DB_PATH" ".backup '$BACKUP_PATH'"
BACKUP_RC=$?
assert_eq "$BACKUP_RC" "0" "sqlite3 .backup exits successfully"
[ -f "$BACKUP_PATH" ] && pass "Backup file created" || fail "Backup file not created"

# Verify backup is a valid SQLite DB
BACKUP_CHECK=$(sqlite3 "$BACKUP_PATH" "PRAGMA integrity_check;" 2>/dev/null | head -1)
assert_eq "$BACKUP_CHECK" "ok" "Backup passes integrity check"

# Verify backup has same data
BACKUP_TASK_COUNT=$(sqlite3 "$BACKUP_PATH" "SELECT COUNT(*) FROM tasks;")
assert_eq "$BACKUP_TASK_COUNT" "$ORIG_TASK_COUNT" "Backup has same task count"

BACKUP_EVENT_COUNT=$(sqlite3 "$BACKUP_PATH" "SELECT COUNT(*) FROM events;")
assert_eq "$BACKUP_EVENT_COUNT" "$ORIG_EVENT_COUNT" "Backup has same event count"

# ── Test: Corrupt the original DB ────────────────────────────────────

echo ""
log "=== Corrupt original DB ==="

# Method: truncate the DB file to corrupt it
# Use dd to overwrite the first 512 bytes with zeros (corrupts the SQLite header)
dd if=/dev/zero of="$DB_PATH" bs=512 count=1 conv=notrunc 2>/dev/null
CORRUPT_CHECK=$(sqlite3 "$DB_PATH" "PRAGMA integrity_check;" 2>/dev/null | head -1)
if [ "$CORRUPT_CHECK" != "ok" ]; then
  pass "Original DB is now corrupted"
else
  # Truncation method: if header overwrite didn't corrupt it, truncate entirely
  : > "$DB_PATH"
  CORRUPT_CHECK2=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM tasks;" 2>/dev/null)
  if [ "$CORRUPT_CHECK2" != "$ORIG_TASK_COUNT" ]; then
    pass "Original DB is now corrupted (truncated)"
  else
    fail "Failed to corrupt the original DB"
  fi
fi

# Verify we cannot read data from the corrupted DB
CORRUPT_READ=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM tasks;" 2>/dev/null || echo "ERROR")
if [ "$CORRUPT_READ" != "$ORIG_TASK_COUNT" ]; then
  pass "Corrupted DB cannot return correct data"
else
  fail "Corrupted DB still returns correct data (corruption may have failed)"
fi

# ── Test: Restore from backup ────────────────────────────────────────

echo ""
log "=== Restore from backup ==="

# Simulate the watchdog restore flow: rename corrupted, restore from backup
CORRUPTED_PATH="$DB_PATH.corrupted"
mv "$DB_PATH" "$CORRUPTED_PATH"
[ ! -f "$DB_PATH" ] && pass "Corrupted DB moved aside" || fail "Corrupted DB not moved"

# Restore using sqlite3 .backup (copies backup to new location)
sqlite3 "$BACKUP_PATH" ".backup '$DB_PATH'"
RESTORE_RC=$?
assert_eq "$RESTORE_RC" "0" "sqlite3 .backup restore exits successfully"
[ -f "$DB_PATH" ] && pass "Restored DB file exists" || fail "Restored DB file not created"

# ── Test: Verify restored data integrity ──────────────────────────────

echo ""
log "=== Verify restored data integrity ==="

# Integrity check
RESTORED_CHECK=$(sqlite3 "$DB_PATH" "PRAGMA integrity_check;" 2>/dev/null | head -1)
assert_eq "$RESTORED_CHECK" "ok" "Restored DB passes integrity check"

# Verify task count matches
RESTORED_TASK_COUNT=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM tasks;")
assert_eq "$RESTORED_TASK_COUNT" "$ORIG_TASK_COUNT" "Restored DB has same task count"

# Verify event count
RESTORED_EVENT_COUNT=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM events;")
assert_eq "$RESTORED_EVENT_COUNT" "$ORIG_EVENT_COUNT" "Restored DB has same event count"

# Verify blocker count
RESTORED_BLOCKER_COUNT=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM blockers;")
assert_eq "$RESTORED_BLOCKER_COUNT" "$ORIG_BLOCKER_COUNT" "Restored DB has same blocker count"

# Verify specific task data
RESTORED_TASK1_TITLE=$(sqlite3 "$DB_PATH" "SELECT title FROM tasks WHERE id=$TASK1_ID;")
assert_eq "$RESTORED_TASK1_TITLE" "$ORIG_TASK1_TITLE" "Restored task 1 title matches"

RESTORED_TASK2_TITLE=$(sqlite3 "$DB_PATH" "SELECT title FROM tasks WHERE id=$TASK2_ID;")
assert_eq "$RESTORED_TASK2_TITLE" "$ORIG_TASK2_TITLE" "Restored task 2 title matches"

RESTORED_TASK3_DESC=$(sqlite3 "$DB_PATH" "SELECT description FROM tasks WHERE id=$TASK3_ID;")
assert_eq "$RESTORED_TASK3_DESC" "$ORIG_TASK3_DESC" "Restored task 3 description matches"

# Verify WAL mode is preserved
RESTORED_WAL=$(sqlite3 "$DB_PATH" "PRAGMA journal_mode;")
assert_eq "$RESTORED_WAL" "wal" "Restored DB has WAL mode"

# Verify all tables still exist
for tbl in tasks blockers workers events fixer_stats _metadata; do
  count=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='$tbl';")
  assert_eq "$count" "1" "Restored DB has table '$tbl'"
done

# Verify _db.sh functions work against the restored DB
RESTORED_PENDING=$(db_count_pending)
assert_eq "$RESTORED_PENDING" "3" "db_count_pending works on restored DB"

RESTORED_BLOCKERS=$(db_count_active_blockers)
assert_eq "$RESTORED_BLOCKERS" "1" "db_count_active_blockers works on restored DB"

# ── Test: Restore handles delete (not just truncate) ──────────────────

echo ""
log "=== Restore after full deletion ==="

rm -f "$DB_PATH" "$DB_PATH-wal" "$DB_PATH-shm"
[ ! -f "$DB_PATH" ] && pass "DB fully deleted" || fail "DB not deleted"

sqlite3 "$BACKUP_PATH" ".backup '$DB_PATH'"
RESTORE2_RC=$?
assert_eq "$RESTORE2_RC" "0" "Restore after deletion succeeds"

RESTORE2_COUNT=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM tasks;")
assert_eq "$RESTORE2_COUNT" "$ORIG_TASK_COUNT" "Restore after deletion has correct task count"

RESTORE2_CHECK=$(sqlite3 "$DB_PATH" "PRAGMA integrity_check;" 2>/dev/null | head -1)
assert_eq "$RESTORE2_CHECK" "ok" "Restore after deletion passes integrity check"

# ── Summary ──────────────────────────────────────────────────────────

echo ""
TOTAL=$((PASS + FAIL))
printf "  Results: %d/%d passed, %d failed\n" "$PASS" "$TOTAL" "$FAIL"
if [ $FAIL -eq 0 ]; then
  printf "  \033[32mAll checks passed!\033[0m\n"
else
  printf "  \033[31mSome checks failed!\033[0m\n"
  exit 1
fi
