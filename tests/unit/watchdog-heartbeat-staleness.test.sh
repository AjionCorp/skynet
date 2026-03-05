#!/usr/bin/env bash
# tests/unit/watchdog-heartbeat-staleness.test.sh — Unit tests for watchdog heartbeat staleness detection
#
# Tests: _handle_stale_worker (file-based), degraded heartbeat fallback,
# stale heartbeat counting loop, hung worker detection, and PID-alive guard.
#
# Usage: bash tests/unit/watchdog-heartbeat-staleness.test.sh

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

assert_file_exists() {
  local file="$1" msg="$2"
  if [ -f "$file" ]; then
    pass "$msg"
  else
    fail "$msg (file '$file' not found)"
  fi
}

assert_file_not_exists() {
  local file="$1" msg="$2"
  if [ -f "$file" ]; then
    fail "$msg (file '$file' should not exist)"
  else
    pass "$msg"
  fi
}

# ── Setup: create isolated environment ──────────────────────────────

TMPDIR_ROOT=$(mktemp -d)
trap 'rm -rf "$TMPDIR_ROOT"' EXIT

export SKYNET_PROJECT_DIR="$TMPDIR_ROOT"
export SKYNET_DEV_DIR="$TMPDIR_ROOT/.dev"
export SKYNET_PROJECT_NAME="test-hb"
export SKYNET_PROJECT_NAME_UPPER="TEST-HB"
export SKYNET_LOCK_PREFIX="/tmp/skynet-test-hb-$$"
export SKYNET_STALE_MINUTES=45
export SKYNET_MAX_WORKERS=4

mkdir -p "$SKYNET_DEV_DIR"

DEV_DIR="$SKYNET_DEV_DIR"
PROJECT_DIR="$SKYNET_PROJECT_DIR"
WORKTREE_BASE="$TMPDIR_ROOT/worktrees"
mkdir -p "$WORKTREE_BASE"

# Log capture file
LOG_CAPTURE="$TMPDIR_ROOT/log-capture.txt"
: > "$LOG_CAPTURE"
log() { echo "$*" >> "$LOG_CAPTURE"; }

# Stubs for functions called by _handle_stale_worker
tg() { :; }
emit_event() { :; }

# Source DB layer
source "$REPO_ROOT/scripts/_compat.sh"
source "$REPO_ROOT/scripts/_db.sh"
db_init

SEP=$'\x1f'

# ============================================================
# Extract _handle_stale_worker from watchdog.sh
# ============================================================

# Use sed to extract the function (it ends with a } at column 0)
eval "$(sed -n '/^_handle_stale_worker()/,/^}$/p' "$REPO_ROOT/scripts/watchdog.sh")"

# ============================================================
# TEST 1: Fresh heartbeat — worker is NOT stale
# ============================================================

echo ""
printf "  %s\n" "=== Test 1: Fresh heartbeat is not stale ==="

NOW=$(date +%s)
echo "$NOW" > "$DEV_DIR/worker-1.heartbeat"
db_set_worker_status 1 "dev" "in_progress" "" "Active task" ""
sqlite3 "$DB_PATH" "UPDATE workers SET heartbeat_epoch = $NOW WHERE id=1;"

: > "$LOG_CAPTURE"
_handle_stale_worker 1
OUTPUT=$(cat "$LOG_CAPTURE")

assert_not_contains "$OUTPUT" "STALE WORKER" "fresh heartbeat: not flagged as stale"
assert_file_exists "$DEV_DIR/worker-1.heartbeat" "fresh heartbeat: heartbeat file preserved"

rm -f "$DEV_DIR/worker-1.heartbeat"

# ============================================================
# TEST 2: No heartbeat file — _handle_stale_worker returns early
# ============================================================

echo ""
printf "  %s\n" "=== Test 2: No heartbeat file skips check ==="

rm -f "$DEV_DIR/worker-2.heartbeat"

: > "$LOG_CAPTURE"
_handle_stale_worker 2
OUTPUT=$(cat "$LOG_CAPTURE")

assert_not_contains "$OUTPUT" "STALE" "no heartbeat file: skips check entirely"

# ============================================================
# TEST 3: Stale heartbeat with dead PID — worker is killed
# ============================================================

echo ""
printf "  %s\n" "=== Test 3: Stale heartbeat + dead PID triggers kill ==="

# Write a stale heartbeat (2 hours old)
STALE_EPOCH=$(( $(date +%s) - 7200 ))
echo "$STALE_EPOCH" > "$DEV_DIR/worker-3.heartbeat"

# Create a task file for unclaim logic
cat > "$DEV_DIR/current-task-3.md" <<EOF
# Current Task
## [FEAT] Stuck task
**Status:** in_progress
EOF

# No lock file / PID => dead PID path
rm -rf "${SKYNET_LOCK_PREFIX}-dev-worker-3.lock"

db_set_worker_status 3 "dev" "in_progress" "" "Stuck task" ""
sqlite3 "$DB_PATH" "UPDATE workers SET heartbeat_epoch = $STALE_EPOCH WHERE id=3;"

: > "$LOG_CAPTURE"
_handle_stale_worker 3
OUTPUT=$(cat "$LOG_CAPTURE")

assert_contains "$OUTPUT" "STALE WORKER 3" "stale+dead: detected as stale"
assert_contains "$OUTPUT" "Killing" "stale+dead: kill action logged"
assert_file_not_exists "$DEV_DIR/worker-3.heartbeat" "stale+dead: heartbeat file cleaned up"

# Verify worker set to idle in DB
WSTAT=$(sqlite3 "$DB_PATH" "SELECT status FROM workers WHERE id=3;")
assert_eq "$WSTAT" "idle" "stale+dead: worker status set to idle in DB"

# ============================================================
# TEST 4: Stale heartbeat but PID is alive — skip kill
# ============================================================

echo ""
printf "  %s\n" "=== Test 4: Stale heartbeat + alive PID skips kill ==="

STALE_EPOCH=$(( $(date +%s) - 7200 ))
echo "$STALE_EPOCH" > "$DEV_DIR/worker-4.heartbeat"

# Create a dir-based lock with our own PID (guaranteed alive)
LOCK_DIR="${SKYNET_LOCK_PREFIX}-dev-worker-4.lock"
mkdir -p "$LOCK_DIR"
echo "$$" > "$LOCK_DIR/pid"

db_set_worker_status 4 "dev" "in_progress" "" "Busy task" ""

: > "$LOG_CAPTURE"
_handle_stale_worker 4
OUTPUT=$(cat "$LOG_CAPTURE")

assert_contains "$OUTPUT" "PID $$ is alive" "stale+alive: PID-alive guard triggered"
assert_not_contains "$OUTPUT" "Killing" "stale+alive: no kill action"
assert_file_exists "$DEV_DIR/worker-4.heartbeat" "stale+alive: heartbeat file preserved"

rm -rf "$LOCK_DIR"
rm -f "$DEV_DIR/worker-4.heartbeat"

# ============================================================
# TEST 5: Degraded heartbeat — falls back to progress_epoch
# ============================================================

echo ""
printf "  %s\n" "=== Test 5: Degraded heartbeat uses progress_epoch ==="

# Write a stale heartbeat (file timestamp is old)
STALE_EPOCH=$(( $(date +%s) - 7200 ))
echo "$STALE_EPOCH" > "$DEV_DIR/worker-1.heartbeat"

# Mark as degraded
touch "$DEV_DIR/worker-1.heartbeat.degraded"

# But progress_epoch is fresh in DB
FRESH_EPOCH=$(date +%s)
db_set_worker_status 1 "dev" "in_progress" "" "Degraded task" ""
sqlite3 "$DB_PATH" "UPDATE workers SET heartbeat_epoch = $STALE_EPOCH, progress_epoch = $FRESH_EPOCH WHERE id=1;"

# No lock file => dead PID, but progress_epoch is fresh so hb_age will be ~0
: > "$LOG_CAPTURE"
_handle_stale_worker 1
OUTPUT=$(cat "$LOG_CAPTURE")

assert_contains "$OUTPUT" "heartbeat degraded" "degraded: detected degraded mode"
assert_contains "$OUTPUT" "progress_epoch" "degraded: logged progress_epoch usage"
assert_not_contains "$OUTPUT" "STALE WORKER" "degraded: fresh progress_epoch prevents stale detection"

rm -f "$DEV_DIR/worker-1.heartbeat" "$DEV_DIR/worker-1.heartbeat.degraded"

# ============================================================
# TEST 6: Degraded heartbeat with stale progress_epoch — still stale
# ============================================================

echo ""
printf "  %s\n" "=== Test 6: Degraded + stale progress_epoch is stale ==="

STALE_EPOCH=$(( $(date +%s) - 7200 ))
echo "$STALE_EPOCH" > "$DEV_DIR/worker-2.heartbeat"
touch "$DEV_DIR/worker-2.heartbeat.degraded"

# Both heartbeat and progress_epoch are stale
db_set_worker_status 2 "dev" "in_progress" "" "Stuck degraded task" ""
sqlite3 "$DB_PATH" "UPDATE workers SET heartbeat_epoch = $STALE_EPOCH, progress_epoch = $STALE_EPOCH WHERE id=2;"

cat > "$DEV_DIR/current-task-2.md" <<EOF
# Current Task
## [FIX] Stuck degraded task
**Status:** in_progress
EOF

rm -rf "${SKYNET_LOCK_PREFIX}-dev-worker-2.lock"

: > "$LOG_CAPTURE"
_handle_stale_worker 2
OUTPUT=$(cat "$LOG_CAPTURE")

assert_contains "$OUTPUT" "heartbeat degraded" "degraded+stale: detected degraded mode"
assert_contains "$OUTPUT" "STALE WORKER 2" "degraded+stale: still detects as stale"
assert_file_not_exists "$DEV_DIR/worker-2.heartbeat" "degraded+stale: heartbeat file cleaned up"

rm -f "$DEV_DIR/worker-2.heartbeat.degraded"

# ============================================================
# TEST 7: Stale heartbeat counting loop
# ============================================================

echo ""
printf "  %s\n" "=== Test 7: Stale heartbeat counting ==="

sqlite3 "$DB_PATH" "DELETE FROM workers;"

NOW=$(date +%s)
STALE_EPOCH=$(( NOW - 7200 ))

# Worker 1: fresh heartbeat file
echo "$NOW" > "$DEV_DIR/worker-1.heartbeat"

# Worker 2: stale heartbeat file
echo "$STALE_EPOCH" > "$DEV_DIR/worker-2.heartbeat"

# Worker 3: stale heartbeat file
echo "$STALE_EPOCH" > "$DEV_DIR/worker-3.heartbeat"

# Worker 4: no heartbeat file (idle)
rm -f "$DEV_DIR/worker-4.heartbeat"

# Count stale heartbeats (mirrors the loop in watchdog.sh)
_stale_heartbeat_count=0
for _wid in $(seq 1 "${SKYNET_MAX_WORKERS:-4}"); do
  _hb_file="$DEV_DIR/worker-${_wid}.heartbeat"
  if [ -f "$_hb_file" ]; then
    _hb_epoch=$(cat "$_hb_file" 2>/dev/null || echo 0)
    _hb_age=$(( $(date +%s) - _hb_epoch ))
    if [ "$_hb_age" -gt $(( ${SKYNET_STALE_MINUTES:-45} * 60 )) ]; then
      _stale_heartbeat_count=$((_stale_heartbeat_count + 1))
    fi
  fi
done

assert_eq "$_stale_heartbeat_count" "2" "counting: 2 of 4 workers have stale heartbeats"

# Cleanup
rm -f "$DEV_DIR/worker-1.heartbeat" "$DEV_DIR/worker-2.heartbeat" "$DEV_DIR/worker-3.heartbeat"

# ============================================================
# TEST 8: db_get_stale_heartbeats — DB-based detection
# ============================================================

echo ""
printf "  %s\n" "=== Test 8: DB-based stale heartbeat detection ==="

sqlite3 "$DB_PATH" "DELETE FROM workers;"

NOW=$(date +%s)
STALE_EPOCH=$(( NOW - 7200 ))  # 2 hours ago
FRESH_EPOCH=$NOW

# Worker 1: fresh heartbeat in DB
db_set_worker_status 1 "dev" "in_progress" "" "Fresh task" ""
sqlite3 "$DB_PATH" "UPDATE workers SET heartbeat_epoch = $FRESH_EPOCH WHERE id=1;"

# Worker 2: stale heartbeat in DB
db_set_worker_status 2 "dev" "in_progress" "" "Stale task" ""
sqlite3 "$DB_PATH" "UPDATE workers SET heartbeat_epoch = $STALE_EPOCH WHERE id=2;"

# Worker 3: no heartbeat (epoch=0)
db_set_worker_status 3 "dev" "idle" "" "" ""
sqlite3 "$DB_PATH" "UPDATE workers SET heartbeat_epoch = 0 WHERE id=3;"

# 45 min threshold = 2700 seconds
STALE_RESULT=$(db_get_stale_heartbeats 2700)

# Each result line starts with "id<SEP>"; use line-start anchor to avoid substring matches
_gc() { local c; c=$(printf '%s' "$1" | grep -c "$2" 2>/dev/null) || c=0; echo "$c"; }
STALE_LINE_COUNT=$(_gc "$STALE_RESULT" "^2${SEP}")
assert_eq "$STALE_LINE_COUNT" "1" "db stale: worker 2 detected as stale"
FRESH_LINE_COUNT=$(_gc "$STALE_RESULT" "^1${SEP}")
assert_eq "$FRESH_LINE_COUNT" "0" "db stale: worker 1 (fresh) not flagged"
ZERO_HB_COUNT=$(_gc "$STALE_RESULT" "^3${SEP}")
assert_eq "$ZERO_HB_COUNT" "0" "db stale: worker 3 (no heartbeat) not flagged"

# ============================================================
# TEST 9: db_get_stale_heartbeats — max_workers filter
# ============================================================

echo ""
printf "  %s\n" "=== Test 9: Stale heartbeats respects max_workers ==="

sqlite3 "$DB_PATH" "DELETE FROM workers;"

NOW=$(date +%s)
STALE_EPOCH=$(( NOW - 7200 ))

# Workers 1-3: stale
for wid in 1 2 3; do
  db_set_worker_status "$wid" "dev" "in_progress" "" "Stale $wid" ""
  sqlite3 "$DB_PATH" "UPDATE workers SET heartbeat_epoch = $STALE_EPOCH WHERE id=$wid;"
done

# With max_workers=2, only workers 1 and 2 should be checked
STALE_FILTERED=$(db_get_stale_heartbeats 2700 2)
STALE_COUNT=$(_gc "$STALE_FILTERED" ".")

assert_eq "$STALE_COUNT" "2" "max_workers: only 2 stale workers returned when max=2"
W3_FILTERED_COUNT=$(_gc "$STALE_FILTERED" "^3${SEP}")
assert_eq "$W3_FILTERED_COUNT" "0" "max_workers: worker 3 excluded by filter"

# ============================================================
# TEST 10: db_get_hung_workers — heartbeat fresh but progress stale
# ============================================================

echo ""
printf "  %s\n" "=== Test 10: Hung worker detection ==="

sqlite3 "$DB_PATH" "DELETE FROM workers;"

NOW=$(date +%s)
STALE_EPOCH=$(( NOW - 7200 ))
STALE_SECS=$(( SKYNET_STALE_MINUTES * 60 ))

# Worker 1: both heartbeat and progress fresh (healthy)
db_set_worker_status 1 "dev" "in_progress" "" "Healthy worker" ""
sqlite3 "$DB_PATH" "UPDATE workers SET heartbeat_epoch = $NOW, progress_epoch = $NOW WHERE id=1;"

# Worker 2: heartbeat fresh, progress stale (hung)
db_set_worker_status 2 "dev" "in_progress" "" "Hung worker" ""
sqlite3 "$DB_PATH" "UPDATE workers SET heartbeat_epoch = $NOW, progress_epoch = $STALE_EPOCH WHERE id=2;"

# Worker 3: both heartbeat and progress stale (regular stale, not hung)
db_set_worker_status 3 "dev" "in_progress" "" "Stale worker" ""
sqlite3 "$DB_PATH" "UPDATE workers SET heartbeat_epoch = $STALE_EPOCH, progress_epoch = $STALE_EPOCH WHERE id=3;"

# Worker 4: idle, should never be detected
db_set_worker_status 4 "dev" "idle" "" "" ""

HUNG_RESULT=$(db_get_hung_workers "$STALE_SECS" 2>/dev/null || true)

HUNG_W2_COUNT=$(_gc "$HUNG_RESULT" "^2${SEP}")
assert_eq "$HUNG_W2_COUNT" "1" "hung: worker 2 detected (fresh HB, stale progress)"
HUNG_W1_COUNT=$(_gc "$HUNG_RESULT" "^1${SEP}")
assert_eq "$HUNG_W1_COUNT" "0" "hung: worker 1 not flagged (both fresh)"
HUNG_W3_COUNT=$(_gc "$HUNG_RESULT" "^3${SEP}")
assert_eq "$HUNG_W3_COUNT" "0" "hung: worker 3 not flagged (stale HB excludes from hung)"
HUNG_W4_COUNT=$(_gc "$HUNG_RESULT" "^4${SEP}")
assert_eq "$HUNG_W4_COUNT" "0" "hung: worker 4 not flagged (idle)"

# ============================================================
# TEST 11: Health score includes stale heartbeat penalty
# ============================================================

echo ""
printf "  %s\n" "=== Test 11: Health score stale heartbeat penalty ==="

sqlite3 "$DB_PATH" "DELETE FROM tasks; DELETE FROM blockers; DELETE FROM workers;"

# Baseline: perfect health
SCORE_CLEAN=$(db_get_health_score 2>/dev/null)
[ "$SCORE_CLEAN" -ge 95 ] 2>/dev/null && pass "health: clean score is high ($SCORE_CLEAN)" || fail "health: expected high clean score (got '$SCORE_CLEAN')"

# Add 3 stale workers: should deduct 3 * 2 = 6 points
NOW=$(date +%s)
STALE_EPOCH=$(( NOW - 7200 ))
for wid in 1 2 3; do
  db_set_worker_status "$wid" "dev" "in_progress" "" "Stale task $wid" ""
  sqlite3 "$DB_PATH" "UPDATE workers SET heartbeat_epoch = $STALE_EPOCH WHERE id=$wid;"
done

SCORE_STALE=$(db_get_health_score 2>/dev/null)
EXPECTED_DROP=$(( SCORE_CLEAN - SCORE_STALE ))

[ "$EXPECTED_DROP" -ge 4 ] 2>/dev/null && pass "health: score dropped by $EXPECTED_DROP with 3 stale heartbeats" || fail "health: expected score drop >= 4 (got $EXPECTED_DROP, clean=$SCORE_CLEAN, stale=$SCORE_STALE)"

# ============================================================
# TEST 12: Stale heartbeat file with file-based lock (not dir-based)
# ============================================================

echo ""
printf "  %s\n" "=== Test 12: File-based lock with stale heartbeat ==="

sqlite3 "$DB_PATH" "DELETE FROM workers;"

STALE_EPOCH=$(( $(date +%s) - 7200 ))
echo "$STALE_EPOCH" > "$DEV_DIR/worker-1.heartbeat"

# Create file-based lock with a dead PID (99999999 is very unlikely to exist)
LOCK_FILE="${SKYNET_LOCK_PREFIX}-dev-worker-1.lock"
rm -rf "$LOCK_FILE"
echo "99999999" > "$LOCK_FILE"

cat > "$DEV_DIR/current-task-1.md" <<EOF
# Current Task
## [CHORE] File lock test
**Status:** in_progress
EOF

db_set_worker_status 1 "dev" "in_progress" "" "File lock test" ""

: > "$LOG_CAPTURE"
_handle_stale_worker 1
OUTPUT=$(cat "$LOG_CAPTURE")

assert_contains "$OUTPUT" "STALE WORKER 1" "file-lock: stale worker detected with file-based lock"
assert_file_not_exists "$DEV_DIR/worker-1.heartbeat" "file-lock: heartbeat cleaned up"

rm -f "$LOCK_FILE"

# ============================================================
# TEST 13: Boundary — heartbeat exactly at threshold is not stale
# ============================================================

echo ""
printf "  %s\n" "=== Test 13: Heartbeat at exact threshold boundary ==="

sqlite3 "$DB_PATH" "DELETE FROM workers;"

# Set heartbeat to exactly stale_seconds ago (should NOT be stale — the check is >)
BOUNDARY_EPOCH=$(( $(date +%s) - (SKYNET_STALE_MINUTES * 60) ))
echo "$BOUNDARY_EPOCH" > "$DEV_DIR/worker-1.heartbeat"

rm -rf "${SKYNET_LOCK_PREFIX}-dev-worker-1.lock"
db_set_worker_status 1 "dev" "in_progress" "" "Boundary task" ""

: > "$LOG_CAPTURE"
_handle_stale_worker 1
OUTPUT=$(cat "$LOG_CAPTURE")

# At exact boundary, age == stale_seconds. The check is > (strictly greater), so not stale.
assert_not_contains "$OUTPUT" "STALE WORKER" "boundary: heartbeat at exact threshold not stale (> not >=)"

rm -f "$DEV_DIR/worker-1.heartbeat"

# ── Summary ──────────────────────────────────────────────────────

echo ""
TOTAL=$((PASS + FAIL))
printf "  %s\n" "Results: $PASS/$TOTAL passed, $FAIL failed"
if [ $FAIL -eq 0 ]; then
  printf "  \033[32mAll checks passed!\033[0m\n"
else
  printf "  \033[31mSome checks failed!\033[0m\n"
  exit 1
fi
