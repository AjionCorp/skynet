#!/usr/bin/env bash
# tests/unit/ui-tester.test.sh — Unit tests for scripts/ui-tester.sh
#
# Tests the validation flow: SKYNET_PLAYWRIGHT_DIR check, dev server reachability,
# Playwright exit code handling, success path (server log check), auth gate,
# backlog saturation prevention, and run_agent error handling.
#
# Usage: bash tests/unit/ui-tester.test.sh

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
  if echo "$haystack" | grep -qF "$needle"; then
    pass "$msg"
  else
    fail "$msg (expected to contain '$needle')"
  fi
}

assert_grep() {
  local file="$1" pattern="$2" msg="$3"
  if grep -q "$pattern" "$file" 2>/dev/null; then
    pass "$msg"
  else
    fail "$msg (pattern '$pattern' not found in $file)"
  fi
}

assert_not_grep() {
  local file="$1" pattern="$2" msg="$3"
  if grep -q "$pattern" "$file" 2>/dev/null; then
    fail "$msg (pattern '$pattern' was found in $file)"
  else
    pass "$msg"
  fi
}

# ── Setup: create isolated environment ──────────────────────────────

TMPDIR_ROOT=$(mktemp -d)
cleanup() {
  rm -rf "$TMPDIR_ROOT"
}
trap cleanup EXIT

# Create directory structure
MOCK_SCRIPTS="$TMPDIR_ROOT/scripts"
MOCK_BIN="$TMPDIR_ROOT/mock-bin"
MOCK_PROJECT="$TMPDIR_ROOT/project"
MOCK_DEV="$TMPDIR_ROOT/.dev"
MOCK_PLAYWRIGHT="$MOCK_PROJECT/e2e"

mkdir -p "$MOCK_SCRIPTS" "$MOCK_BIN" "$MOCK_PROJECT" "$MOCK_DEV" "$MOCK_PLAYWRIGHT"

# Create mock backlog file
MOCK_BACKLOG="$MOCK_DEV/backlog.md"
cat > "$MOCK_BACKLOG" <<'EOF'
# Backlog
- [ ] [FIX] Fix login page
- [ ] [FIX] Fix dashboard API
- [x] [DONE] Add search feature
EOF

# Create mock blockers file
MOCK_BLOCKERS="$MOCK_DEV/blockers.md"
touch "$MOCK_BLOCKERS"

# Write standard mock _config.sh
_write_config() {
  local lock_rc="${1:-0}"
  local agent_track="${2:-no}"
  local agent_rc="${3:-0}"
  cat > "$MOCK_SCRIPTS/_config.sh" <<CONFIGEOF
#!/usr/bin/env bash
export SKYNET_PROJECT_NAME="test-project"
export SKYNET_PROJECT_NAME_UPPER="TEST-PROJECT"
export SKYNET_PROJECT_DIR="$MOCK_PROJECT"
export SKYNET_DEV_DIR="$MOCK_DEV"
export SKYNET_DEV_SERVER_URL="http://localhost:9999"
export SKYNET_LOCK_PREFIX="$TMPDIR_ROOT/locks/skynet-test"
export SKYNET_PLAYWRIGHT_DIR="e2e"
export SCRIPTS_DIR="$MOCK_SCRIPTS"
export LOG_DIR="$MOCK_SCRIPTS"
export PROJECT_DIR="$MOCK_PROJECT"
export DEV_DIR="$MOCK_DEV"
export BACKLOG="$MOCK_BACKLOG"
export BLOCKERS="$MOCK_BLOCKERS"
mkdir -p "$TMPDIR_ROOT/locks"
acquire_worker_lock() { return $lock_rc; }
tg() { :; }
CONFIGEOF

  if [ "$agent_track" = "track" ]; then
    cat >> "$MOCK_SCRIPTS/_config.sh" <<AGENTEOF
run_agent() { echo "RUN_AGENT_CALLED" >> "$TMPDIR_ROOT/agent-calls"; return $agent_rc; }
AGENTEOF
  else
    cat >> "$MOCK_SCRIPTS/_config.sh" <<AGENTEOF
run_agent() { return $agent_rc; }
AGENTEOF
  fi
}

# Create mock auth-check.sh (default: auth succeeds)
_write_auth_ok() {
  cat > "$MOCK_SCRIPTS/auth-check.sh" <<'AUTHEOF'
#!/usr/bin/env bash
check_any_auth() { return 0; }
AUTHEOF
}

_write_auth_fail() {
  cat > "$MOCK_SCRIPTS/auth-check.sh" <<'AUTHEOF'
#!/usr/bin/env bash
check_any_auth() { return 1; }
AUTHEOF
}

# Create mock check-server-errors.sh
_write_server_errors_ok() {
  cat > "$MOCK_SCRIPTS/check-server-errors.sh" <<'SEOF'
#!/usr/bin/env bash
exit 0
SEOF
  chmod +x "$MOCK_SCRIPTS/check-server-errors.sh"
}

_write_server_errors_fail() {
  cat > "$MOCK_SCRIPTS/check-server-errors.sh" <<'SEOF'
#!/usr/bin/env bash
exit 1
SEOF
  chmod +x "$MOCK_SCRIPTS/check-server-errors.sh"
}

# Copy the actual ui-tester.sh into the mock scripts dir
cp "$REPO_ROOT/scripts/ui-tester.sh" "$MOCK_SCRIPTS/ui-tester.sh"

# Create a mock curl (default: server is reachable)
_make_mock_curl_ok() {
  cat > "$MOCK_BIN/curl" <<'CURLEOF'
#!/usr/bin/env bash
exit 0
CURLEOF
  chmod +x "$MOCK_BIN/curl"
}

_make_mock_curl_fail() {
  cat > "$MOCK_BIN/curl" <<'CURLEOF'
#!/usr/bin/env bash
exit 1
CURLEOF
  chmod +x "$MOCK_BIN/curl"
}

# Create a mock npx that simulates playwright output
_make_mock_npx_pass() {
  cat > "$MOCK_BIN/npx" <<'NPXEOF'
#!/usr/bin/env bash
echo "Running 3 tests using 1 worker"
echo "  ✓ login page loads correctly (2.1s)"
echo "  ✓ dashboard shows data (1.5s)"
echo "  ✓ API returns valid response (0.8s)"
echo ""
echo "  3 passed"
exit 0
NPXEOF
  chmod +x "$MOCK_BIN/npx"
}

_make_mock_npx_fail() {
  cat > "$MOCK_BIN/npx" <<'NPXEOF'
#!/usr/bin/env bash
echo "Running 5 tests using 1 worker"
echo "  ✓ login page loads correctly (2.1s)"
echo "  ✓ dashboard shows data (1.5s)"
echo "  ✗ search returns results (3.2s)"
echo "  ✓ API returns valid response (0.8s)"
echo "  FAILED settings page crashes (1.1s)"
echo ""
echo "  3 passed, 2 failed"
exit 1
NPXEOF
  chmod +x "$MOCK_BIN/npx"
}

# Helper to run ui-tester.sh in an isolated subprocess
_run_tester() {
  local exit_code=0
  (
    export PATH="$MOCK_BIN:$PATH"
    cd "$MOCK_PROJECT"
    bash "$MOCK_SCRIPTS/ui-tester.sh" 2>&1
  ) > "$TMPDIR_ROOT/last-output" 2>&1 || exit_code=$?
  echo "$exit_code"
}

# Reset log file between tests
_reset_log() {
  rm -f "$MOCK_SCRIPTS/ui-tester.log"
  touch "$MOCK_SCRIPTS/ui-tester.log"
}

# ── Test 1: SKYNET_PLAYWRIGHT_DIR not set — exits 1 ────────────────

echo ""
log "=== SKYNET_PLAYWRIGHT_DIR: exits 1 when not set ==="

# Write config WITHOUT SKYNET_PLAYWRIGHT_DIR
cat > "$MOCK_SCRIPTS/_config.sh" <<CONFIGEOF
#!/usr/bin/env bash
export SKYNET_PROJECT_NAME="test-project"
export SKYNET_PROJECT_NAME_UPPER="TEST-PROJECT"
export SKYNET_PROJECT_DIR="$MOCK_PROJECT"
export SKYNET_DEV_DIR="$MOCK_DEV"
export SKYNET_DEV_SERVER_URL="http://localhost:9999"
export SKYNET_LOCK_PREFIX="$TMPDIR_ROOT/locks/skynet-test"
export SCRIPTS_DIR="$MOCK_SCRIPTS"
export LOG_DIR="$MOCK_SCRIPTS"
export PROJECT_DIR="$MOCK_PROJECT"
export DEV_DIR="$MOCK_DEV"
export BACKLOG="$MOCK_BACKLOG"
# NOTE: SKYNET_PLAYWRIGHT_DIR intentionally not set
unset SKYNET_PLAYWRIGHT_DIR 2>/dev/null || true
mkdir -p "$TMPDIR_ROOT/locks"
acquire_worker_lock() { return 0; }
tg() { :; }
run_agent() { return 0; }
CONFIGEOF

_reset_log
_make_mock_curl_ok
exit_code=$(_run_tester)
assert_eq "$exit_code" "1" "SKYNET_PLAYWRIGHT_DIR: script exits 1 when not set"

assert_grep "$MOCK_SCRIPTS/ui-tester.log" "SKYNET_PLAYWRIGHT_DIR is not set" \
  "SKYNET_PLAYWRIGHT_DIR: logs error message"

# ── Test 2: Dev server not reachable — exits 0 ─────────────────────

echo ""
log "=== dev server: exits 0 when not reachable ==="

_write_config
_write_auth_ok

_reset_log
_make_mock_curl_fail
exit_code=$(_run_tester)
assert_eq "$exit_code" "0" "dev server: script exits 0 when server unreachable"

assert_grep "$MOCK_SCRIPTS/ui-tester.log" "Dev server not reachable" \
  "dev server: logs 'Dev server not reachable' message"

# ── Test 3: All tests pass — exits 0 with success message ──────────

echo ""
log "=== all tests pass: exits 0 ==="

_write_config
_write_auth_ok
_write_server_errors_ok

_reset_log
_make_mock_curl_ok
_make_mock_npx_pass
exit_code=$(_run_tester)
assert_eq "$exit_code" "0" "all tests pass: script exits 0"

assert_grep "$MOCK_SCRIPTS/ui-tester.log" "All smoke tests passed" \
  "all tests pass: logs success message"

# ── Test 4: All tests pass — checks server logs when next-dev.log exists ─

echo ""
log "=== success path: checks server logs ==="

_write_config
_write_auth_ok
_write_server_errors_ok

# Create a next-dev.log to trigger the server error check
touch "$MOCK_SCRIPTS/next-dev.log"

_reset_log
_make_mock_curl_ok
_make_mock_npx_pass
exit_code=$(_run_tester)
assert_eq "$exit_code" "0" "success path: exits 0"

assert_grep "$MOCK_SCRIPTS/ui-tester.log" "Checking server logs" \
  "success path: checks server logs when next-dev.log exists"

# Clean up
rm -f "$MOCK_SCRIPTS/next-dev.log"

# ── Test 5: Success path — server errors found logged ────────────────

echo ""
log "=== success path: logs when server errors found ==="

_write_config
_write_auth_ok
_write_server_errors_fail

# Create next-dev.log to trigger the check
touch "$MOCK_SCRIPTS/next-dev.log"

_reset_log
_make_mock_curl_ok
_make_mock_npx_pass
exit_code=$(_run_tester)
assert_eq "$exit_code" "0" "server errors: exits 0 even with server errors"

assert_grep "$MOCK_SCRIPTS/ui-tester.log" "Server errors found" \
  "server errors: logs 'Server errors found' message"

rm -f "$MOCK_SCRIPTS/next-dev.log"

# ── Test 6: Success path — no next-dev.log skips server check ────────

echo ""
log "=== success path: skips server check when no next-dev.log ==="

_write_config
_write_auth_ok
_write_server_errors_ok

# Ensure no next-dev.log
rm -f "$MOCK_SCRIPTS/next-dev.log"

_reset_log
_make_mock_curl_ok
_make_mock_npx_pass
exit_code=$(_run_tester)
assert_eq "$exit_code" "0" "no log file: exits 0"

assert_not_grep "$MOCK_SCRIPTS/ui-tester.log" "Checking server logs" \
  "no log file: does not check server logs when next-dev.log missing"

# ── Test 7: Lock acquisition failure — exits 0 ─────────────────────

echo ""
log "=== lock contention: exits 0 when lock held ==="

_write_config 1  # lock_rc=1 (lock fails)
_write_auth_ok

_reset_log
_make_mock_curl_ok
exit_code=$(_run_tester)
assert_eq "$exit_code" "0" "lock contention: exits 0 when lock already held"

# ── Test 8: Tests fail, no auth — skips analysis ────────────────────

echo ""
log "=== auth gate: skips analysis when no auth ==="

_write_config
_write_auth_fail

_reset_log
_make_mock_curl_ok
_make_mock_npx_fail
exit_code=$(_run_tester)
assert_eq "$exit_code" "0" "auth gate: exits 0 when auth unavailable"

assert_grep "$MOCK_SCRIPTS/ui-tester.log" "No agent auth available" \
  "auth gate: logs 'No agent auth available' message"

# ── Test 9: Tests fail, auth OK, backlog below threshold — runs agent ─

echo ""
log "=== analysis runs: backlog below threshold ==="

_write_config 0 track  # track agent calls
_write_auth_ok

cat > "$MOCK_BACKLOG" <<'EOF'
# Backlog
- [ ] [FIX] Fix login page
- [ ] [FIX] Fix dashboard API
- [x] [DONE] Completed task
EOF

rm -f "$TMPDIR_ROOT/agent-calls"

_reset_log
_make_mock_curl_ok
_make_mock_npx_fail
exit_code=$(_run_tester)

if [ -f "$TMPDIR_ROOT/agent-calls" ]; then
  pass "analysis runs: run_agent was called when backlog < 15"
else
  fail "analysis runs: run_agent should be called when backlog < 15"
fi

assert_grep "$MOCK_SCRIPTS/ui-tester.log" "UI tester analysis completed" \
  "analysis runs: logs analysis completed message"

# ── Test 10: Backlog saturation — skips task creation at 15+ tasks ──

echo ""
log "=== backlog saturation: skips at 15+ pending tasks ==="

_write_config 0 track  # track agent calls
_write_auth_ok

# Create a saturated backlog (16 unchecked items)
{
  echo "# Backlog"
  for i in $(seq 1 16); do
    echo "- [ ] [FIX] Fix issue $i"
  done
} > "$MOCK_BACKLOG"

rm -f "$TMPDIR_ROOT/agent-calls"

_reset_log
_make_mock_curl_ok
_make_mock_npx_fail
exit_code=$(_run_tester)
assert_eq "$exit_code" "0" "backlog saturation: exits 0 (skips task creation)"

assert_grep "$MOCK_SCRIPTS/ui-tester.log" "Backlog already has" \
  "backlog saturation: logs saturation message"

if [ -f "$TMPDIR_ROOT/agent-calls" ]; then
  fail "backlog saturation: run_agent should NOT be called when backlog >= 15"
else
  pass "backlog saturation: run_agent was not called"
fi

# ── Test 11: Backlog at exactly 15 — triggers saturation ────────────

echo ""
log "=== backlog saturation: exactly 15 pending tasks ==="

_write_config 0 track
_write_auth_ok

{
  echo "# Backlog"
  for i in $(seq 1 15); do
    echo "- [ ] [FIX] Fix issue $i"
  done
} > "$MOCK_BACKLOG"

rm -f "$TMPDIR_ROOT/agent-calls"

_reset_log
_make_mock_curl_ok
_make_mock_npx_fail
exit_code=$(_run_tester)
assert_eq "$exit_code" "0" "backlog saturation: exits 0 at exactly 15 tasks"

assert_grep "$MOCK_SCRIPTS/ui-tester.log" "Backlog already has" \
  "backlog saturation: triggers at exactly 15 pending tasks"

if [ -f "$TMPDIR_ROOT/agent-calls" ]; then
  fail "backlog saturation: run_agent should NOT be called at exactly 15 tasks"
else
  pass "backlog saturation: run_agent not called at exactly 15 tasks"
fi

# ── Test 12: Backlog at 14 — does NOT trigger saturation ────────────

echo ""
log "=== backlog below threshold: 14 pending tasks ==="

_write_config 0 track
_write_auth_ok

{
  echo "# Backlog"
  for i in $(seq 1 14); do
    echo "- [ ] [FIX] Fix issue $i"
  done
} > "$MOCK_BACKLOG"

rm -f "$TMPDIR_ROOT/agent-calls"

_reset_log
_make_mock_curl_ok
_make_mock_npx_fail
exit_code=$(_run_tester)

if [ -f "$TMPDIR_ROOT/agent-calls" ]; then
  pass "backlog below threshold: run_agent called at 14 tasks"
else
  fail "backlog below threshold: run_agent should be called when pending < 15"
fi

# ── Test 13: run_agent fails — logs exit code ───────────────────────

echo ""
log "=== run_agent failure: logs exit code ==="

_write_config 0 no 42  # agent_rc=42
_write_auth_ok

cat > "$MOCK_BACKLOG" <<'EOF'
# Backlog
- [ ] [FIX] Fix login page
EOF

_reset_log
_make_mock_curl_ok
_make_mock_npx_fail
exit_code=$(_run_tester)

assert_grep "$MOCK_SCRIPTS/ui-tester.log" "exited with code 42" \
  "run_agent failure: logs the exit code"

# ── Test 14: Playwright exit code logged ─────────────────────────────

echo ""
log "=== exit code logging: logs Playwright exit code ==="

_write_config
_write_auth_ok

_reset_log
_make_mock_curl_ok
_make_mock_npx_fail
exit_code=$(_run_tester)

assert_grep "$MOCK_SCRIPTS/ui-tester.log" "Playwright exited with code 1" \
  "exit code logging: logs Playwright exit code"

# ── Test 15: Playwright output logged ────────────────────────────────

echo ""
log "=== output logging: test output written to log ==="

_write_config
_write_auth_ok

_reset_log
_make_mock_curl_ok
_make_mock_npx_fail
exit_code=$(_run_tester)

assert_grep "$MOCK_SCRIPTS/ui-tester.log" "3 passed, 2 failed" \
  "output logging: Playwright output captured in log"

# ── Test 16: Empty backlog — remaining count is 0, analysis runs ────

echo ""
log "=== empty backlog: remaining count is 0 ==="

_write_config 0 track
_write_auth_ok

: > "$MOCK_BACKLOG"
rm -f "$TMPDIR_ROOT/agent-calls"

_reset_log
_make_mock_curl_ok
_make_mock_npx_fail
exit_code=$(_run_tester)

if [ -f "$TMPDIR_ROOT/agent-calls" ]; then
  pass "empty backlog: run_agent called when backlog is empty"
else
  fail "empty backlog: run_agent should be called when backlog is empty (0 < 15)"
fi

# ── Test 17: Missing backlog file — script errors on cat ─────────────

echo ""
log "=== missing backlog file: script errors during prompt construction ==="

_write_config 0 track
_write_auth_ok

rm -f "$MOCK_BACKLOG"
rm -f "$TMPDIR_ROOT/agent-calls"

_reset_log
_make_mock_curl_ok
_make_mock_npx_fail
exit_code=$(_run_tester)

# With no backlog file, remaining=0 (< 15) so analysis path runs.
# But cat "$BACKLOG" in the prompt construction fails under set -euo pipefail,
# causing the script to exit non-zero before run_agent is called.
if [ "$exit_code" -ne 0 ]; then
  pass "missing backlog: script exits non-zero when backlog file missing"
else
  fail "missing backlog: should exit non-zero (cat \$BACKLOG fails under set -e)"
fi

if [ ! -f "$TMPDIR_ROOT/agent-calls" ]; then
  pass "missing backlog: run_agent not called (script exited before reaching it)"
else
  fail "missing backlog: run_agent should not be called when cat \$BACKLOG fails"
fi

# Recreate backlog for remaining tests
cat > "$MOCK_BACKLOG" <<'EOF'
# Backlog
- [ ] [FIX] Fix login page
EOF

# ── Test 18: Completed tasks (checked boxes) not counted ─────────────

echo ""
log "=== backlog counting: only counts unchecked tasks ==="

_write_config 0 track
_write_auth_ok

cat > "$MOCK_BACKLOG" <<'EOF'
# Backlog
- [ ] [FIX] Fix issue 1
- [x] [DONE] Completed issue 2
- [ ] [FIX] Fix issue 3
- [x] [DONE] Completed issue 4
- [x] [DONE] Completed issue 5
EOF

rm -f "$TMPDIR_ROOT/agent-calls"

_reset_log
_make_mock_curl_ok
_make_mock_npx_fail
exit_code=$(_run_tester)

# Only 2 unchecked tasks, well below 15 — agent should be called
if [ -f "$TMPDIR_ROOT/agent-calls" ]; then
  pass "backlog counting: only unchecked tasks counted (2 < 15, agent called)"
else
  fail "backlog counting: agent should run — only 2 unchecked tasks (not 5 total)"
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
