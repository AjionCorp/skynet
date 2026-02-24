#!/usr/bin/env bash
# tests/unit/auth-check.test.sh — Unit tests for scripts/auth-check.sh
#
# Tests: check_claude_auth, check_codex_auth, check_gemini_auth, check_any_auth,
# and alert throttling.
#
# Usage: bash tests/unit/auth-check.test.sh

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

# ── Setup: create isolated environment ──────────────────────────────

TMPDIR_ROOT=$(mktemp -d)
cleanup() {
  rm -rf "$TMPDIR_ROOT"
  # Clean up any PATH manipulation
  export PATH="$ORIG_PATH"
}
trap cleanup EXIT
ORIG_PATH="$PATH"

# Minimal config stubs required by auth-check.sh
export SKYNET_PROJECT_NAME="test-auth"
export SKYNET_PROJECT_NAME_UPPER="TEST_AUTH"
export SKYNET_DEV_DIR="$TMPDIR_ROOT/.dev"
export SKYNET_LOCK_PREFIX="/tmp/skynet-test-auth"
export SKYNET_AUTH_TOKEN_CACHE="$TMPDIR_ROOT/claude-token"
export SKYNET_AUTH_FAIL_FLAG="$TMPDIR_ROOT/auth-failed"
export SKYNET_CODEX_AUTH_FAIL_FLAG="$TMPDIR_ROOT/codex-auth-failed"
export SKYNET_GEMINI_AUTH_FAIL_FLAG="$TMPDIR_ROOT/gemini-auth-failed"
export SKYNET_AUTH_NOTIFY_INTERVAL=3600
export SKYNET_CODEX_NOTIFY_INTERVAL=3600
export SKYNET_GEMINI_NOTIFY_INTERVAL=3600
export SKYNET_ALL_AUTH_NOTIFY_INTERVAL=3600
export SCRIPTS_DIR="$REPO_ROOT/scripts"
export BLOCKERS="$TMPDIR_ROOT/.dev/blockers.md"
export LOG="$TMPDIR_ROOT/test.log"

mkdir -p "$SKYNET_DEV_DIR"
touch "$BLOCKERS"

# Create mock bin directory for mock commands
MOCK_BIN="$TMPDIR_ROOT/mock-bin"
mkdir -p "$MOCK_BIN"

# Stub out tg (Telegram) and _notify_all — they should not send real messages
tg() { :; }
_notify_all() { :; }
export -f tg _notify_all

# Source auth-check.sh
source "$REPO_ROOT/scripts/auth-check.sh"

# ── Test: check_claude_auth returns 1 when token cache is empty ──────

echo ""
log "=== check_claude_auth: empty token cache ==="

# Ensure token cache does not exist
rm -f "$SKYNET_AUTH_TOKEN_CACHE"
rm -f "$SKYNET_AUTH_FAIL_FLAG"

if check_claude_auth 2>/dev/null; then
  fail "check_claude_auth: should return 1 when token cache is empty"
else
  pass "check_claude_auth: returns 1 when token cache is empty"
fi

# ── Test: check_claude_auth returns 1 when token is invalid ──────────

echo ""
log "=== check_claude_auth: invalid token ==="

# Write a dummy token
echo "invalid-token-abc123" > "$SKYNET_AUTH_TOKEN_CACHE"
rm -f "$SKYNET_AUTH_FAIL_FLAG"

# Create a mock curl that always fails (simulates invalid token)
cat > "$MOCK_BIN/curl" <<'MOCK_CURL'
#!/usr/bin/env bash
exit 1
MOCK_CURL
chmod +x "$MOCK_BIN/curl"
export PATH="$MOCK_BIN:$ORIG_PATH"

if check_claude_auth 2>/dev/null; then
  fail "check_claude_auth: should return 1 when curl fails (invalid token)"
else
  pass "check_claude_auth: returns 1 when curl fails (invalid token)"
fi

# Restore PATH
export PATH="$ORIG_PATH"

# ── Test: check_codex_auth returns 1 when binary not found ───────────

echo ""
log "=== check_codex_auth: binary not found ==="

# Ensure codex is not in PATH (use a non-existent binary name)
export SKYNET_CODEX_BIN="nonexistent-codex-binary-$$"
rm -f "$SKYNET_CODEX_AUTH_FAIL_FLAG"

if check_codex_auth 2>/dev/null; then
  fail "check_codex_auth: should return 1 when codex binary not found"
else
  pass "check_codex_auth: returns 1 when codex binary not found"
fi

# ── Test: check_gemini_auth returns 1 when no API key and no ADC ─────

echo ""
log "=== check_gemini_auth: no API key, no ADC ==="

# Create a mock gemini binary so it passes the command-v check
cat > "$MOCK_BIN/test-gemini" <<'MOCK_GEMINI'
#!/usr/bin/env bash
exit 0
MOCK_GEMINI
chmod +x "$MOCK_BIN/test-gemini"
export PATH="$MOCK_BIN:$ORIG_PATH"
export SKYNET_GEMINI_BIN="test-gemini"

# Unset all auth env vars
unset GEMINI_API_KEY 2>/dev/null || true
unset GOOGLE_API_KEY 2>/dev/null || true
# Point ADC to a non-existent path
export GOOGLE_APPLICATION_CREDENTIALS="$TMPDIR_ROOT/nonexistent-adc.json"
rm -f "$SKYNET_GEMINI_AUTH_FAIL_FLAG"

if check_gemini_auth 2>/dev/null; then
  fail "check_gemini_auth: should return 1 when no API key and no ADC file"
else
  pass "check_gemini_auth: returns 1 when no API key and no ADC file"
fi

# Restore PATH
export PATH="$ORIG_PATH"

# ── Test: check_any_auth returns 1 when all three fail ───────────────

echo ""
log "=== check_any_auth: all agents fail ==="

# Set up all three to fail:
# Claude: empty token cache
rm -f "$SKYNET_AUTH_TOKEN_CACHE"
rm -f "$SKYNET_AUTH_FAIL_FLAG"

# Codex: non-existent binary
export SKYNET_CODEX_BIN="nonexistent-codex-binary-$$"
rm -f "$SKYNET_CODEX_AUTH_FAIL_FLAG"

# Gemini: non-existent binary (no gemini command)
export SKYNET_GEMINI_BIN="nonexistent-gemini-binary-$$"
rm -f "$SKYNET_GEMINI_AUTH_FAIL_FLAG"
unset GEMINI_API_KEY 2>/dev/null || true
unset GOOGLE_API_KEY 2>/dev/null || true

# Clean up sentinel
ALL_AUTH_FAIL_SENTINEL="/tmp/skynet-test-auth-all-auth-expired"
rm -f "$ALL_AUTH_FAIL_SENTINEL"

if check_any_auth 2>/dev/null; then
  fail "check_any_auth: should return 1 when all three agents fail"
else
  pass "check_any_auth: returns 1 when all three agents fail"
fi

# ── Test: Alert throttling ───────────────────────────────────────────

echo ""
log "=== alert throttling ==="

# First call should have set the fail flag timestamp
rm -f "$SKYNET_AUTH_FAIL_FLAG"
rm -f "$SKYNET_AUTH_TOKEN_CACHE"

# Stub auth-refresh to not exist
unset SCRIPTS_DIR_SAVED
SCRIPTS_DIR_SAVED="$SCRIPTS_DIR"
export SCRIPTS_DIR="$TMPDIR_ROOT/no-scripts"
mkdir -p "$SCRIPTS_DIR"

# First call — sets the fail flag
check_claude_auth 2>/dev/null || true

# Verify fail flag was created
if [ -f "$SKYNET_AUTH_FAIL_FLAG" ]; then
  pass "throttle: fail flag created on first failure"
else
  fail "throttle: fail flag should be created on first failure"
fi

# Record the timestamp in the fail flag
first_ts=$(cat "$SKYNET_AUTH_FAIL_FLAG" 2>/dev/null || echo "0")

# Second call within AUTH_NOTIFY_INTERVAL — should NOT update the fail flag
sleep 1
check_claude_auth 2>/dev/null || true

second_ts=$(cat "$SKYNET_AUTH_FAIL_FLAG" 2>/dev/null || echo "0")

assert_eq "$first_ts" "$second_ts" "throttle: second call within interval doesn't update fail flag timestamp"

# Restore SCRIPTS_DIR
export SCRIPTS_DIR="$SCRIPTS_DIR_SAVED"

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
