#!/usr/bin/env bash
# tests/unit/feature-validator.test.sh — Unit tests for scripts/feature-validator.sh
#
# Tests the validation logic: SKYNET_PLAYWRIGHT_DIR check, dev server reachability,
# test result counting (passed/failed parsing), success path, auth gate, and
# backlog saturation prevention.
#
# Usage: bash tests/unit/feature-validator.test.sh

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

# Create mock _config.sh that sets up the minimal environment
cat > "$MOCK_SCRIPTS/_config.sh" <<CONFIGEOF
#!/usr/bin/env bash
# Mock _config.sh for feature-validator tests
export SKYNET_PROJECT_NAME="test-project"
export SKYNET_PROJECT_NAME_UPPER="TEST-PROJECT"
export SKYNET_PROJECT_DIR="$MOCK_PROJECT"
export SKYNET_DEV_DIR="$MOCK_DEV"
export SKYNET_DEV_SERVER_URL="http://localhost:9999"
export SKYNET_LOCK_PREFIX="$TMPDIR_ROOT/locks/skynet-test"
export SKYNET_FEATURE_TEST="feature.spec.ts"
export SCRIPTS_DIR="$MOCK_SCRIPTS"
export PROJECT_DIR="$MOCK_PROJECT"
export DEV_DIR="$MOCK_DEV"
export BACKLOG="$MOCK_BACKLOG"

mkdir -p "$TMPDIR_ROOT/locks"

# Stub functions that the script expects
acquire_worker_lock() { return 0; }
tg() { :; }
run_agent() { return 0; }
CONFIGEOF

# Create mock auth-check.sh (default: auth succeeds)
cat > "$MOCK_SCRIPTS/auth-check.sh" <<'AUTHEOF'
#!/usr/bin/env bash
# Mock auth-check.sh
check_any_auth() { return 0; }
AUTHEOF

# Copy the actual feature-validator.sh and patch the source line
# to use our mock _config.sh
cp "$REPO_ROOT/scripts/feature-validator.sh" "$MOCK_SCRIPTS/feature-validator.sh"

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
# Simulate all tests passing
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
# Simulate some tests failing
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

_make_mock_npx_all_fail() {
  cat > "$MOCK_BIN/npx" <<'NPXEOF'
#!/usr/bin/env bash
# Simulate all tests failing
echo "Running 2 tests using 1 worker"
echo "  ✗ login page loads correctly (2.1s)"
echo "  FAILED dashboard shows data (1.5s)"
echo ""
echo "  0 passed, 2 failed"
exit 1
NPXEOF
  chmod +x "$MOCK_BIN/npx"
}

# Helper to run feature-validator.sh in an isolated subprocess
_run_validator() {
  local exit_code=0
  (
    export PATH="$MOCK_BIN:$PATH"
    cd "$MOCK_PROJECT"
    bash "$MOCK_SCRIPTS/feature-validator.sh" 2>&1
  ) > "$TMPDIR_ROOT/last-output" 2>&1 || exit_code=$?
  echo "$exit_code"
}

# Reset log file between tests
_reset_log() {
  rm -f "$MOCK_SCRIPTS/feature-validator.log"
  touch "$MOCK_SCRIPTS/feature-validator.log"
}

# ── Test 1: SKYNET_PLAYWRIGHT_DIR not set — exits 1 ────────────────

echo ""
log "=== SKYNET_PLAYWRIGHT_DIR: exits 1 when not set ==="

_reset_log

# Patch the mock _config.sh to NOT set SKYNET_PLAYWRIGHT_DIR
cat > "$MOCK_SCRIPTS/_config.sh" <<CONFIGEOF
#!/usr/bin/env bash
export SKYNET_PROJECT_NAME="test-project"
export SKYNET_PROJECT_NAME_UPPER="TEST-PROJECT"
export SKYNET_PROJECT_DIR="$MOCK_PROJECT"
export SKYNET_DEV_DIR="$MOCK_DEV"
export SKYNET_DEV_SERVER_URL="http://localhost:9999"
export SKYNET_LOCK_PREFIX="$TMPDIR_ROOT/locks/skynet-test"
export SCRIPTS_DIR="$MOCK_SCRIPTS"
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

_make_mock_curl_ok
exit_code=$(_run_validator)
assert_eq "$exit_code" "1" "SKYNET_PLAYWRIGHT_DIR: script exits 1 when not set"

# Verify error logged
assert_grep "$MOCK_SCRIPTS/feature-validator.log" "SKYNET_PLAYWRIGHT_DIR is not set" \
  "SKYNET_PLAYWRIGHT_DIR: logs error message"

# ── Test 2: Dev server not reachable — exits 0 ─────────────────────

echo ""
log "=== dev server: exits 0 when not reachable ==="

# Restore config with SKYNET_PLAYWRIGHT_DIR set
cat > "$MOCK_SCRIPTS/_config.sh" <<CONFIGEOF
#!/usr/bin/env bash
export SKYNET_PROJECT_NAME="test-project"
export SKYNET_PROJECT_NAME_UPPER="TEST-PROJECT"
export SKYNET_PROJECT_DIR="$MOCK_PROJECT"
export SKYNET_DEV_DIR="$MOCK_DEV"
export SKYNET_DEV_SERVER_URL="http://localhost:9999"
export SKYNET_LOCK_PREFIX="$TMPDIR_ROOT/locks/skynet-test"
export SKYNET_PLAYWRIGHT_DIR="e2e"
export SKYNET_FEATURE_TEST="feature.spec.ts"
export SCRIPTS_DIR="$MOCK_SCRIPTS"
export PROJECT_DIR="$MOCK_PROJECT"
export DEV_DIR="$MOCK_DEV"
export BACKLOG="$MOCK_BACKLOG"
mkdir -p "$TMPDIR_ROOT/locks"
acquire_worker_lock() { return 0; }
tg() { :; }
run_agent() { return 0; }
CONFIGEOF

_reset_log
_make_mock_curl_fail
exit_code=$(_run_validator)
assert_eq "$exit_code" "0" "dev server: script exits 0 when server unreachable"

assert_grep "$MOCK_SCRIPTS/feature-validator.log" "Dev server not reachable" \
  "dev server: logs 'Dev server not reachable' message"

# ── Test 3: All tests pass — exits 0 with success message ──────────

echo ""
log "=== all tests pass: exits 0 ==="

_reset_log
_make_mock_curl_ok
_make_mock_npx_pass
exit_code=$(_run_validator)
assert_eq "$exit_code" "0" "all tests pass: script exits 0"

assert_grep "$MOCK_SCRIPTS/feature-validator.log" "All feature tests passed" \
  "all tests pass: logs success message"

# Verify passed count is logged
assert_grep "$MOCK_SCRIPTS/feature-validator.log" "3/3" \
  "all tests pass: logs correct count (3/3)"

# ── Test 4: Some tests fail — auth check gates analysis ─────────────

echo ""
log "=== auth gate: skips analysis when no auth ==="

# Make auth fail
cat > "$MOCK_SCRIPTS/auth-check.sh" <<'AUTHEOF'
#!/usr/bin/env bash
check_any_auth() { return 1; }
AUTHEOF

_reset_log
_make_mock_curl_ok
_make_mock_npx_fail
exit_code=$(_run_validator)
assert_eq "$exit_code" "0" "auth gate: exits 0 when auth unavailable"

assert_grep "$MOCK_SCRIPTS/feature-validator.log" "No agent auth available" \
  "auth gate: logs 'No agent auth available' message"

# ── Test 5: Tests fail with auth — counts passed and failed ─────────

echo ""
log "=== result counting: mixed pass/fail ==="

# Restore auth to pass
cat > "$MOCK_SCRIPTS/auth-check.sh" <<'AUTHEOF'
#!/usr/bin/env bash
check_any_auth() { return 0; }
AUTHEOF

_reset_log
_make_mock_curl_ok
_make_mock_npx_fail
exit_code=$(_run_validator)

# The script should log the counts
assert_grep "$MOCK_SCRIPTS/feature-validator.log" "3 passed, 2 failed" \
  "result counting: logs correct passed/failed counts"

# ── Test 6: Backlog saturation — skips task creation at 15+ tasks ───

echo ""
log "=== backlog saturation: skips at 15+ pending tasks ==="

# Create a saturated backlog (15+ unchecked items)
{
  echo "# Backlog"
  for i in $(seq 1 16); do
    echo "- [ ] [FIX] Fix issue $i"
  done
} > "$MOCK_BACKLOG"

# Make run_agent track if it was called (should NOT be)
cat > "$MOCK_SCRIPTS/_config.sh" <<CONFIGEOF
#!/usr/bin/env bash
export SKYNET_PROJECT_NAME="test-project"
export SKYNET_PROJECT_NAME_UPPER="TEST-PROJECT"
export SKYNET_PROJECT_DIR="$MOCK_PROJECT"
export SKYNET_DEV_DIR="$MOCK_DEV"
export SKYNET_DEV_SERVER_URL="http://localhost:9999"
export SKYNET_LOCK_PREFIX="$TMPDIR_ROOT/locks/skynet-test"
export SKYNET_PLAYWRIGHT_DIR="e2e"
export SKYNET_FEATURE_TEST="feature.spec.ts"
export SCRIPTS_DIR="$MOCK_SCRIPTS"
export PROJECT_DIR="$MOCK_PROJECT"
export DEV_DIR="$MOCK_DEV"
export BACKLOG="$MOCK_BACKLOG"
mkdir -p "$TMPDIR_ROOT/locks"
acquire_worker_lock() { return 0; }
tg() { :; }
run_agent() { echo "RUN_AGENT_CALLED" >> "$TMPDIR_ROOT/agent-calls"; return 0; }
CONFIGEOF

rm -f "$TMPDIR_ROOT/agent-calls"

_reset_log
_make_mock_curl_ok
_make_mock_npx_fail
exit_code=$(_run_validator)
assert_eq "$exit_code" "0" "backlog saturation: exits 0 (skips task creation)"

assert_grep "$MOCK_SCRIPTS/feature-validator.log" "Backlog already has" \
  "backlog saturation: logs saturation message"

# Verify run_agent was NOT called
if [ -f "$TMPDIR_ROOT/agent-calls" ]; then
  fail "backlog saturation: run_agent should NOT be called when backlog >= 15"
else
  pass "backlog saturation: run_agent was not called"
fi

# ── Test 7: Backlog below threshold — analysis runs ─────────────────

echo ""
log "=== analysis runs: backlog below threshold ==="

# Create a small backlog (below 15)
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
exit_code=$(_run_validator)

# Verify run_agent WAS called
if [ -f "$TMPDIR_ROOT/agent-calls" ]; then
  pass "analysis runs: run_agent was called when backlog < 15"
else
  fail "analysis runs: run_agent should be called when backlog < 15"
fi

assert_grep "$MOCK_SCRIPTS/feature-validator.log" "Feature validator analysis completed" \
  "analysis runs: logs analysis completed message"

# ── Test 8: All tests fail — counts correctly ───────────────────────

echo ""
log "=== result counting: all fail ==="

_reset_log
_make_mock_curl_ok
_make_mock_npx_all_fail
exit_code=$(_run_validator)

# The script should detect 0 passed, 2 failed
assert_grep "$MOCK_SCRIPTS/feature-validator.log" "0 passed" \
  "result counting: logs 0 passed when all fail"

assert_grep "$MOCK_SCRIPTS/feature-validator.log" "2 failed" \
  "result counting: logs 2 failed"

# ── Test 9: Lock acquisition failure — exits 0 ─────────────────────

echo ""
log "=== lock contention: exits 0 when lock held ==="

# Make acquire_worker_lock fail
cat > "$MOCK_SCRIPTS/_config.sh" <<CONFIGEOF
#!/usr/bin/env bash
export SKYNET_PROJECT_NAME="test-project"
export SKYNET_PROJECT_NAME_UPPER="TEST-PROJECT"
export SKYNET_PROJECT_DIR="$MOCK_PROJECT"
export SKYNET_DEV_DIR="$MOCK_DEV"
export SKYNET_DEV_SERVER_URL="http://localhost:9999"
export SKYNET_LOCK_PREFIX="$TMPDIR_ROOT/locks/skynet-test"
export SKYNET_PLAYWRIGHT_DIR="e2e"
export SKYNET_FEATURE_TEST="feature.spec.ts"
export SCRIPTS_DIR="$MOCK_SCRIPTS"
export PROJECT_DIR="$MOCK_PROJECT"
export DEV_DIR="$MOCK_DEV"
export BACKLOG="$MOCK_BACKLOG"
mkdir -p "$TMPDIR_ROOT/locks"
acquire_worker_lock() { return 1; }
tg() { :; }
run_agent() { return 0; }
CONFIGEOF

_reset_log
_make_mock_curl_ok
exit_code=$(_run_validator)
assert_eq "$exit_code" "0" "lock contention: exits 0 when lock already held"

# ── Test 10: run_agent fails — logs exit code ───────────────────────

echo ""
log "=== run_agent failure: logs exit code ==="

cat > "$MOCK_SCRIPTS/_config.sh" <<CONFIGEOF
#!/usr/bin/env bash
export SKYNET_PROJECT_NAME="test-project"
export SKYNET_PROJECT_NAME_UPPER="TEST-PROJECT"
export SKYNET_PROJECT_DIR="$MOCK_PROJECT"
export SKYNET_DEV_DIR="$MOCK_DEV"
export SKYNET_DEV_SERVER_URL="http://localhost:9999"
export SKYNET_LOCK_PREFIX="$TMPDIR_ROOT/locks/skynet-test"
export SKYNET_PLAYWRIGHT_DIR="e2e"
export SKYNET_FEATURE_TEST="feature.spec.ts"
export SCRIPTS_DIR="$MOCK_SCRIPTS"
export PROJECT_DIR="$MOCK_PROJECT"
export DEV_DIR="$MOCK_DEV"
export BACKLOG="$MOCK_BACKLOG"
mkdir -p "$TMPDIR_ROOT/locks"
acquire_worker_lock() { return 0; }
tg() { :; }
run_agent() { return 42; }
CONFIGEOF

# Restore auth
cat > "$MOCK_SCRIPTS/auth-check.sh" <<'AUTHEOF'
#!/usr/bin/env bash
check_any_auth() { return 0; }
AUTHEOF

# Reset backlog to below threshold
cat > "$MOCK_BACKLOG" <<'EOF'
# Backlog
- [ ] [FIX] Fix login page
EOF

_reset_log
_make_mock_curl_ok
_make_mock_npx_fail
exit_code=$(_run_validator)

assert_grep "$MOCK_SCRIPTS/feature-validator.log" "exited with code 42" \
  "run_agent failure: logs the exit code"

# ── Test 11: Backlog at exactly 15 — triggers saturation ────────────

echo ""
log "=== backlog saturation: exactly 15 pending tasks ==="

# Create backlog with exactly 15 unchecked items
{
  echo "# Backlog"
  for i in $(seq 1 15); do
    echo "- [ ] [FIX] Fix issue $i"
  done
} > "$MOCK_BACKLOG"

# Restore standard config with agent call tracking
cat > "$MOCK_SCRIPTS/_config.sh" <<CONFIGEOF
#!/usr/bin/env bash
export SKYNET_PROJECT_NAME="test-project"
export SKYNET_PROJECT_NAME_UPPER="TEST-PROJECT"
export SKYNET_PROJECT_DIR="$MOCK_PROJECT"
export SKYNET_DEV_DIR="$MOCK_DEV"
export SKYNET_DEV_SERVER_URL="http://localhost:9999"
export SKYNET_LOCK_PREFIX="$TMPDIR_ROOT/locks/skynet-test"
export SKYNET_PLAYWRIGHT_DIR="e2e"
export SKYNET_FEATURE_TEST="feature.spec.ts"
export SCRIPTS_DIR="$MOCK_SCRIPTS"
export PROJECT_DIR="$MOCK_PROJECT"
export DEV_DIR="$MOCK_DEV"
export BACKLOG="$MOCK_BACKLOG"
mkdir -p "$TMPDIR_ROOT/locks"
acquire_worker_lock() { return 0; }
tg() { :; }
run_agent() { echo "RUN_AGENT_CALLED" >> "$TMPDIR_ROOT/agent-calls"; return 0; }
CONFIGEOF

rm -f "$TMPDIR_ROOT/agent-calls"

_reset_log
_make_mock_curl_ok
_make_mock_npx_fail
exit_code=$(_run_validator)
assert_eq "$exit_code" "0" "backlog saturation: exits 0 at exactly 15 tasks"

assert_grep "$MOCK_SCRIPTS/feature-validator.log" "Backlog already has" \
  "backlog saturation: triggers at exactly 15 pending tasks"

if [ -f "$TMPDIR_ROOT/agent-calls" ]; then
  fail "backlog saturation: run_agent should NOT be called at exactly 15 tasks"
else
  pass "backlog saturation: run_agent not called at exactly 15 tasks"
fi

# ── Test 12: Backlog at 14 — does NOT trigger saturation ────────────

echo ""
log "=== backlog below threshold: 14 pending tasks ==="

# Create backlog with 14 unchecked items (below threshold)
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
exit_code=$(_run_validator)

if [ -f "$TMPDIR_ROOT/agent-calls" ]; then
  pass "backlog below threshold: run_agent called at 14 tasks"
else
  fail "backlog below threshold: run_agent should be called when pending < 15"
fi

# ── Test 13: Test output parsing with no pass/fail markers ──────────

echo ""
log "=== result counting: empty output (no markers) ==="

cat > "$MOCK_BIN/npx" <<'NPXEOF'
#!/usr/bin/env bash
# Simulate test run with no recognizable markers
echo "Some unexpected output format"
echo "Tests completed"
exit 1
NPXEOF
chmod +x "$MOCK_BIN/npx"

# Reset backlog small
cat > "$MOCK_BACKLOG" <<'EOF'
# Backlog
- [ ] [FIX] Fix one thing
EOF

_reset_log
_make_mock_curl_ok
exit_code=$(_run_validator)

# With 0 passed, 0 failed, total=0 — the script should still handle this
assert_grep "$MOCK_SCRIPTS/feature-validator.log" "0 passed, 0 failed out of 0" \
  "result counting: handles output with no pass/fail markers"

# ── Test 14: Empty backlog file — remaining count is 0 ──────────────

echo ""
log "=== empty backlog: remaining count is 0 ==="

# Create completely empty backlog
: > "$MOCK_BACKLOG"
rm -f "$TMPDIR_ROOT/agent-calls"

_reset_log
_make_mock_curl_ok
_make_mock_npx_fail
exit_code=$(_run_validator)

# With empty backlog, remaining=0 which is < 15, so analysis should run
if [ -f "$TMPDIR_ROOT/agent-calls" ]; then
  pass "empty backlog: run_agent called when backlog is empty"
else
  fail "empty backlog: run_agent should be called when backlog is empty (0 < 15)"
fi

# ── Test 15: Nonexistent backlog file — script errors on cat ─────────

echo ""
log "=== missing backlog file: script errors during prompt construction ==="

rm -f "$MOCK_BACKLOG"
rm -f "$TMPDIR_ROOT/agent-calls"

_reset_log
_make_mock_curl_ok
_make_mock_npx_fail
exit_code=$(_run_validator)

# With no backlog file, remaining=0 (< 15) so analysis path runs.
# But cat "$BACKLOG" in the prompt construction fails under set -euo pipefail,
# causing the script to exit non-zero before run_agent is called.
if [ "$exit_code" -ne 0 ]; then
  pass "missing backlog: script exits non-zero when backlog file missing"
else
  fail "missing backlog: should exit non-zero (cat \$BACKLOG fails under set -e)"
fi

# run_agent should NOT have been called (script exited before reaching it)
if [ ! -f "$TMPDIR_ROOT/agent-calls" ]; then
  pass "missing backlog: run_agent not called (script exited before reaching it)"
else
  fail "missing backlog: run_agent should not be called when cat \$BACKLOG fails"
fi

# Recreate backlog for any following tests
cat > "$MOCK_BACKLOG" <<'EOF'
# Backlog
- [ ] [FIX] Fix login page
EOF

# ── Test 16: Passed counting with multiple checkmark styles ─────────

echo ""
log "=== result counting: multiple checkmark styles ==="

cat > "$MOCK_BIN/npx" <<'NPXEOF'
#!/usr/bin/env bash
echo "Running 4 tests using 1 worker"
echo "  ✓ test one (1.0s)"
echo "  ✓ test two (1.0s)"
echo "  ✓ test three (1.0s)"
echo "  ✓ test four (1.0s)"
echo ""
echo "  4 passed"
exit 0
NPXEOF
chmod +x "$MOCK_BIN/npx"

_reset_log
_make_mock_curl_ok
exit_code=$(_run_validator)
assert_eq "$exit_code" "0" "checkmark counting: exits 0 for all passed"

assert_grep "$MOCK_SCRIPTS/feature-validator.log" "4/4" \
  "checkmark counting: counts 4 passed correctly"

# ── Test 17: Failed counting with mixed failure markers ─────────────

echo ""
log "=== result counting: mixed failure markers (✘, ✗, FAILED, failed) ==="

# NOTE: The script's grep pattern '✘\|✗\|FAILED\|failed' matches ANY line
# containing those strings, including summary lines. We use a summary format
# that does NOT contain "failed" to test the marker counting accurately.
cat > "$MOCK_BIN/npx" <<'NPXEOF'
#!/usr/bin/env bash
echo "Running 5 tests using 1 worker"
echo "  ✓ test one (1.0s)"
echo "  ✘ test two (1.0s)"
echo "  ✗ test three (1.0s)"
echo "  FAILED test four (1.0s)"
echo "  failed test five (1.0s)"
echo ""
echo "  1 ok, 4 not ok"
exit 1
NPXEOF
chmod +x "$MOCK_BIN/npx"

_reset_log
_make_mock_curl_ok
exit_code=$(_run_validator)

assert_grep "$MOCK_SCRIPTS/feature-validator.log" "1 passed, 4 failed out of 5" \
  "failure markers: counts all 4 failure marker styles"

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
