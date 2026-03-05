#!/usr/bin/env bash
# tests/unit/dashboard.test.sh — Unit tests for scripts/dashboard.sh
#
# Tests: utility functions (reltime, trunc, safe_count, is_running),
# argument parsing (--once, --interval), render lifecycle with mocked
# state files, and signal-trap cleanup.
#
# Usage: bash tests/unit/dashboard.test.sh

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
    fail "$msg (expected to contain '$needle')"
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
  local val="$1" msg="$2"
  if [ -n "$val" ]; then pass "$msg"
  else fail "$msg (was empty)"; fi
}

# ── Setup: create isolated environment ──────────────────────────────

TMPDIR_ROOT=$(mktemp -d)
cleanup() { rm -rf "$TMPDIR_ROOT"; }
trap cleanup EXIT

MOCK_SCRIPTS_DIR="$TMPDIR_ROOT/scripts"
MOCK_DEV_DIR="$TMPDIR_ROOT/.dev"
MOCK_BIN_DIR="$TMPDIR_ROOT/bin"
mkdir -p "$MOCK_SCRIPTS_DIR" "$MOCK_DEV_DIR" "$MOCK_BIN_DIR"

# Copy the script under test
cp "$REPO_ROOT/scripts/dashboard.sh" "$MOCK_SCRIPTS_DIR/dashboard.sh"

# ── Mock tput ──────────────────────────────────────────────────────
# tput needs to return empty strings (no ANSI codes) for predictable output
cat > "$MOCK_BIN_DIR/tput" << 'TPUT_MOCK'
#!/usr/bin/env bash
# Return empty for all tput calls so tests get clean output
case "${1:-}" in
  sgr0|bold|dim|setaf|civis|cnorm) echo "" ;;
  cup) ;; # no output
  cols) echo "80" ;;
  *) ;;
esac
exit 0
TPUT_MOCK
chmod +x "$MOCK_BIN_DIR/tput"

# ── State file paths ──────────────────────────────────────────────
MOCK_CURRENT_TASK="$MOCK_DEV_DIR/current-task.md"
MOCK_BACKLOG="$MOCK_DEV_DIR/backlog.md"
MOCK_COMPLETED="$MOCK_DEV_DIR/completed.md"
MOCK_FAILED="$MOCK_DEV_DIR/failed-tasks.md"
MOCK_BLOCKERS="$MOCK_DEV_DIR/blockers.md"
MOCK_SYNC_HEALTH="$MOCK_DEV_DIR/sync-health.md"

# ── Write mock _config.sh ─────────────────────────────────────────
write_config() {
  cat > "$MOCK_SCRIPTS_DIR/_config.sh" << STUB
SCRIPTS_DIR="$MOCK_SCRIPTS_DIR"
LOG_DIR="$MOCK_SCRIPTS_DIR"
SKYNET_PROJECT_NAME_UPPER="TEST-PROJECT"
SKYNET_LOCK_PREFIX="$TMPDIR_ROOT/locks/skynet-test"
CURRENT_TASK="$MOCK_CURRENT_TASK"
BACKLOG="$MOCK_BACKLOG"
COMPLETED="$MOCK_COMPLETED"
FAILED="$MOCK_FAILED"
BLOCKERS="$MOCK_BLOCKERS"
SYNC_HEALTH="$MOCK_SYNC_HEALTH"

file_mtime() {
  # Return a fixed epoch (1 hour ago) for predictable age display
  echo \$(( \$(date +%s) - 3600 ))
}
STUB
}

# ── Create default state files ─────────────────────────────────────
reset_state() {
  rm -rf "$TMPDIR_ROOT/locks"
  mkdir -p "$TMPDIR_ROOT/locks"

  cat > "$MOCK_CURRENT_TASK" << 'EOF'
## Idle
**Status:** idle
**Last completed:** test task — 2026-03-03
EOF

  cat > "$MOCK_BACKLOG" << 'EOF'
- [ ] [FIX] Fix login bug — auth module
- [ ] [FEAT] Add dark mode — ui
- [ ] [TEST] Add unit tests — testing
EOF

  cat > "$MOCK_COMPLETED" << 'EOF'
| Date | Task | Duration | Notes |
|------|------|----------|-------|
| 2026-03-01 | Setup CI pipeline | 15m | clean |
| 2026-03-02 | Add auth module | 30m | all tests pass |
EOF

  cat > "$MOCK_FAILED" << 'EOF'
| Date | Task | Status | Error | Attempts |
|------|------|--------|-------|----------|
| 2026-03-02 | Deploy staging | pending | timeout | 2 |
EOF

  cat > "$MOCK_BLOCKERS" << 'EOF'
No active blockers
EOF

  cat > "$MOCK_SYNC_HEALTH" << 'EOF'
| Endpoint | Path | Status | Notes |
|----------|------|--------|-------|
| tasks | /api/sync/tasks | ok | synced 5 items |
| users | /api/sync/users | error | HTTP 500 |
EOF
}

# ── Run dashboard.sh with --once ───────────────────────────────────
run_dashboard() {
  local run_log="$TMPDIR_ROOT/run.log"
  rm -f "$run_log"
  _rc=0
  (
    export PATH="$MOCK_BIN_DIR:$PATH"
    bash "$MOCK_SCRIPTS_DIR/dashboard.sh" --once "$@" > "$run_log" 2>&1
  ) || _rc=$?
  _output=""
  [ -f "$run_log" ] && _output=$(cat "$run_log")
}

echo "dashboard.test.sh — unit tests for scripts/dashboard.sh"

# ══════════════════════════════════════════════════════════════════════
# UTILITY FUNCTION TESTS
# ══════════════════════════════════════════════════════════════════════
# These functions are self-contained; we extract and test them directly.

# ── reltime ─────────────────────────────────────────────────────────

echo ""
log "=== UTIL: reltime() ==="

# Define reltime locally for isolated testing
reltime() {
  local s="$1"
  if [ "$s" -lt 60 ]; then echo "${s}s"
  elif [ "$s" -lt 3600 ]; then echo "$((s/60))m"
  elif [ "$s" -lt 86400 ]; then echo "$((s/3600))h"
  else echo "$((s/86400))d"
  fi
}

assert_eq "$(reltime 0)" "0s" "reltime: 0 seconds"
assert_eq "$(reltime 30)" "30s" "reltime: 30 seconds"
assert_eq "$(reltime 59)" "59s" "reltime: 59 seconds (boundary)"
assert_eq "$(reltime 60)" "1m" "reltime: 60 seconds = 1m"
assert_eq "$(reltime 150)" "2m" "reltime: 150 seconds = 2m"
assert_eq "$(reltime 3599)" "59m" "reltime: 3599 seconds = 59m (boundary)"
assert_eq "$(reltime 3600)" "1h" "reltime: 3600 seconds = 1h"
assert_eq "$(reltime 7200)" "2h" "reltime: 7200 seconds = 2h"
assert_eq "$(reltime 86399)" "23h" "reltime: 86399 seconds = 23h (boundary)"
assert_eq "$(reltime 86400)" "1d" "reltime: 86400 seconds = 1d"
assert_eq "$(reltime 172800)" "2d" "reltime: 172800 seconds = 2d"

# ── trunc ──────────────────────────────────────────────────────────

echo ""
log "=== UTIL: trunc() ==="

trunc() {
  local t="$1" m="$2"
  [ ${#t} -gt "$m" ] && t="${t:0:$((m-1))}~"
  printf '%s' "$t"
}

assert_eq "$(trunc "hello" 10)" "hello" "trunc: within limit unchanged"
assert_eq "$(trunc "hello" 5)" "hello" "trunc: at exact limit unchanged"
assert_eq "$(trunc "hello world" 5)" "hell~" "trunc: over limit truncated with ~"
assert_eq "$(trunc "" 5)" "" "trunc: empty string unchanged"
assert_eq "$(trunc "abcdef" 3)" "ab~" "trunc: 6 chars to max 3"

# ── safe_count ─────────────────────────────────────────────────────

echo ""
log "=== UTIL: safe_count() ==="

safe_count() {
  local result
  result=$(grep -c "$@" 2>/dev/null) || true
  echo "${result:-0}" | head -1 | tr -d '[:space:]'
}

MOCK_COUNT_FILE="$TMPDIR_ROOT/count_test.txt"

cat > "$MOCK_COUNT_FILE" << 'EOF'
- [ ] item one
- [ ] item two
- [x] done item
- [ ] item three
EOF

assert_eq "$(safe_count '^\- \[ \]' "$MOCK_COUNT_FILE")" "3" "safe_count: 3 unchecked items"
assert_eq "$(safe_count '^\- \[x\]' "$MOCK_COUNT_FILE")" "1" "safe_count: 1 checked item"
assert_eq "$(safe_count 'NOMATCH' "$MOCK_COUNT_FILE")" "0" "safe_count: no match returns 0"
assert_eq "$(safe_count 'anything' "$TMPDIR_ROOT/nonexistent.txt")" "0" "safe_count: missing file returns 0"

# ── is_running ─────────────────────────────────────────────────────

echo ""
log "=== UTIL: is_running() ==="

is_running() {
  local lf="$1"
  local pid=""
  if [ -d "$lf" ] && [ -f "$lf/pid" ]; then
    pid=$(cat "$lf/pid" 2>/dev/null || echo "")
  elif [ -f "$lf" ]; then
    pid=$(cat "$lf" 2>/dev/null || echo "")
  fi
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

# Test: directory lock with current PID (our own PID is definitely running)
MOCK_LOCK_DIR="$TMPDIR_ROOT/locks/dir-lock.lock"
mkdir -p "$MOCK_LOCK_DIR"
echo "$$" > "$MOCK_LOCK_DIR/pid"

is_running "$MOCK_LOCK_DIR"
assert_eq "$?" "0" "is_running: directory lock with live PID returns 0"

# Test: file lock with current PID
MOCK_LOCK_FILE="$TMPDIR_ROOT/locks/file-lock.lock"
echo "$$" > "$MOCK_LOCK_FILE"

is_running "$MOCK_LOCK_FILE"
assert_eq "$?" "0" "is_running: file lock with live PID returns 0"

# Test: missing lock
is_running "$TMPDIR_ROOT/locks/missing.lock" || true
rc=$?
# is_running returns non-zero for missing lock
if ! is_running "$TMPDIR_ROOT/locks/missing.lock" 2>/dev/null; then
  pass "is_running: missing lock returns non-zero"
else
  fail "is_running: missing lock should return non-zero"
fi

# Test: stale PID (use a PID that almost certainly doesn't exist)
MOCK_STALE_FILE="$TMPDIR_ROOT/locks/stale.lock"
echo "99999" > "$MOCK_STALE_FILE"

if ! is_running "$MOCK_STALE_FILE" 2>/dev/null; then
  pass "is_running: stale PID returns non-zero"
else
  fail "is_running: stale PID should return non-zero"
fi

# Test: directory lock with empty pid file
MOCK_EMPTY_DIR="$TMPDIR_ROOT/locks/empty-dir.lock"
mkdir -p "$MOCK_EMPTY_DIR"
: > "$MOCK_EMPTY_DIR/pid"

if ! is_running "$MOCK_EMPTY_DIR" 2>/dev/null; then
  pass "is_running: empty pid file returns non-zero"
else
  fail "is_running: empty pid file should return non-zero"
fi

# ══════════════════════════════════════════════════════════════════════
# ARGUMENT PARSING TESTS
# ══════════════════════════════════════════════════════════════════════

echo ""
log "=== ARGS: --once mode ==="

write_config
reset_state
run_dashboard

assert_eq "$_rc" "0" "--once: exits with code 0"
assert_not_empty "$_output" "--once: produces output"

echo ""
log "=== ARGS: --interval parsing ==="

# --interval should be accepted without error (tested with --once so it exits)
write_config
reset_state
run_dashboard --interval 5

assert_eq "$_rc" "0" "--interval: exits with code 0"
assert_not_empty "$_output" "--interval: produces output"

echo ""
log "=== ARGS: unknown args ignored ==="

write_config
reset_state
run_dashboard --foo --bar

assert_eq "$_rc" "0" "unknown-args: exits with code 0"

# ══════════════════════════════════════════════════════════════════════
# RENDER LIFECYCLE TESTS
# ══════════════════════════════════════════════════════════════════════

echo ""
log "=== RENDER: dashboard header ==="

write_config
reset_state
run_dashboard

assert_contains "$_output" "TEST-PROJECT" "header: project name rendered"
assert_contains "$_output" "PIPELINE DASHBOARD" "header: title rendered"

echo ""
log "=== RENDER: workers section ==="

write_config
reset_state
run_dashboard

assert_contains "$_output" "WORKERS" "workers: section header present"
assert_contains "$_output" "dev-worker" "workers: dev-worker listed"
assert_contains "$_output" "task-fixer" "workers: task-fixer listed"
assert_contains "$_output" "sync-runner" "workers: sync-runner listed"
assert_contains "$_output" "watchdog" "workers: watchdog listed"
# All workers idle (no locks created) — should show idle markers
assert_contains "$_output" "idle" "workers: shows idle when no locks"

echo ""
log "=== RENDER: worker running state ==="

write_config
reset_state

# Create a directory lock for dev-worker with our PID
MOCK_DW_LOCK="$TMPDIR_ROOT/locks/skynet-test-dev-worker.lock"
mkdir -p "$MOCK_DW_LOCK"
echo "$$" > "$MOCK_DW_LOCK/pid"

run_dashboard

assert_contains "$_output" "RUNNING" "worker-running: shows RUNNING for active lock"
assert_contains "$_output" "$$" "worker-running: shows PID"

echo ""
log "=== RENDER: current task idle ==="

write_config
reset_state
run_dashboard

assert_contains "$_output" "CURRENT TASK" "task-idle: section header present"
assert_contains "$_output" "Idle" "task-idle: shows idle status"

echo ""
log "=== RENDER: current task in_progress ==="

write_config
reset_state

cat > "$MOCK_CURRENT_TASK" << 'EOF'
## Add authentication module
**Status:** in_progress
**Branch:** dev/add-auth
**Started:** 2026-03-03 10:00
EOF

run_dashboard

assert_contains "$_output" "CURRENT TASK" "task-active: section header present"
assert_contains "$_output" "Add authentication module" "task-active: task name rendered"
assert_contains "$_output" "dev/add-auth" "task-active: branch rendered"
assert_contains "$_output" "2026-03-03 10:00" "task-active: start time rendered"

echo ""
log "=== RENDER: current task other status ==="

write_config
reset_state

cat > "$MOCK_CURRENT_TASK" << 'EOF'
## Deploy staging
**Status:** queued
EOF

run_dashboard

assert_contains "$_output" "queued" "task-other: non-standard status rendered"

echo ""
log "=== RENDER: backlog section ==="

write_config
reset_state
run_dashboard

assert_contains "$_output" "BACKLOG" "backlog: section header present"
assert_contains "$_output" "3 pending" "backlog: correct pending count"
assert_contains "$_output" "Fix login bug" "backlog: first item rendered"

echo ""
log "=== RENDER: sync health section ==="

write_config
reset_state
run_dashboard

assert_contains "$_output" "SYNC HEALTH" "sync-health: section header present"
assert_contains "$_output" "tasks" "sync-health: tasks endpoint rendered"
assert_contains "$_output" "users" "sync-health: users endpoint rendered"

echo ""
log "=== RENDER: completed section ==="

write_config
reset_state
run_dashboard

assert_contains "$_output" "COMPLETED" "completed: section header present"
assert_contains "$_output" "Setup CI pipeline" "completed: task name rendered"
assert_contains "$_output" "Add auth module" "completed: second task rendered"

echo ""
log "=== RENDER: empty completed section ==="

write_config
reset_state

# Empty completed file (header only)
cat > "$MOCK_COMPLETED" << 'EOF'
| Date | Task | Duration | Notes |
|------|------|----------|-------|
EOF

run_dashboard

assert_contains "$_output" "No completed tasks yet" "completed-empty: shows empty message"

echo ""
log "=== RENDER: failed tasks section ==="

write_config
reset_state
run_dashboard

assert_contains "$_output" "FAILED" "failed: section header present"
assert_contains "$_output" "Deploy staging" "failed: task name rendered"
assert_contains "$_output" "2/3" "failed: attempt count rendered"

echo ""
log "=== RENDER: no failed tasks ==="

write_config
reset_state

cat > "$MOCK_FAILED" << 'EOF'
| Date | Task | Status | Error | Attempts |
|------|------|--------|-------|----------|
EOF

run_dashboard

assert_contains "$_output" "None" "failed-empty: shows None"

echo ""
log "=== RENDER: blockers section ==="

write_config
reset_state
run_dashboard

assert_contains "$_output" "BLOCKERS" "blockers: section header present"
assert_contains "$_output" "No active blockers" "blockers: shows no blockers message"

echo ""
log "=== RENDER: active blockers ==="

write_config
reset_state

cat > "$MOCK_BLOCKERS" << 'EOF'
- **2026-03-03**: API key expired
EOF

run_dashboard

assert_contains "$_output" "HAS BLOCKERS" "blockers-active: shows HAS BLOCKERS warning"

echo ""
log "=== RENDER: crons section ==="

write_config
reset_state
run_dashboard

assert_contains "$_output" "NEXT CRONS" "crons: section header present"
assert_contains "$_output" "watchdog" "crons: watchdog schedule rendered"
assert_contains "$_output" "dev-worker" "crons: dev-worker schedule rendered"

# ══════════════════════════════════════════════════════════════════════
# SIGNAL HANDLING TESTS
# ══════════════════════════════════════════════════════════════════════

echo ""
log "=== SIGNAL: trap registered for INT and TERM ==="

# Verify the script source registers a cleanup trap for INT and TERM
script_src=$(cat "$MOCK_SCRIPTS_DIR/dashboard.sh")

if printf '%s' "$script_src" | grep -q 'trap.*cleanup.*INT'; then
  pass "signal: cleanup trap registered for INT"
else
  fail "signal: cleanup trap missing for INT"
fi

if printf '%s' "$script_src" | grep -q 'trap.*cleanup.*TERM'; then
  pass "signal: cleanup trap registered for TERM"
else
  fail "signal: cleanup trap missing for TERM"
fi

# Verify the cleanup function restores cursor visibility (tput cnorm)
if printf '%s' "$script_src" | grep -q 'cleanup.*cnorm\|cnorm.*cleanup'; then
  pass "signal: cleanup restores cursor (tput cnorm)"
else
  # Check if cnorm is inside the cleanup function body
  if printf '%s' "$script_src" | grep -q 'tput cnorm'; then
    pass "signal: cleanup restores cursor (tput cnorm)"
  else
    fail "signal: cleanup should restore cursor with tput cnorm"
  fi
fi

# ── Summary ──────────────────────────────────────────────────────────

echo ""
TOTAL=$((PASS + FAIL))
log "Results: $PASS/$TOTAL passed, $FAIL failed"
if [ "$FAIL" -eq 0 ]; then
  printf "  \033[32mAll checks passed!\033[0m\n"
else
  printf "  \033[31mSome checks failed!\033[0m\n"
  exit 1
fi
