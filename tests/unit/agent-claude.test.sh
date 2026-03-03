#!/usr/bin/env bash
# tests/unit/agent-claude.test.sh — Unit tests for scripts/agents/claude.sh
#
# Tests: agent_check (binary detection, token cache, auth fail flag),
#        agent_run (prompt piping, model flag, log output, _agent_exec usage)
#
# Usage: bash tests/unit/agent-claude.test.sh

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
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    pass "$msg"
  else
    fail "$msg (expected to contain '$needle', got '$haystack')"
  fi
}

# ── Setup: create isolated environment ──────────────────────────────

TMPDIR_ROOT=$(mktemp -d)
ORIG_PATH="$PATH"
cleanup() {
  export PATH="$ORIG_PATH"
  rm -rf "$TMPDIR_ROOT"
}
trap cleanup EXIT

# Create mock bin directory
MOCK_BIN="$TMPDIR_ROOT/mock-bin"
mkdir -p "$MOCK_BIN"

# Set up env vars expected by claude.sh
export SKYNET_CLAUDE_BIN="mock-claude"
export SKYNET_CLAUDE_FLAGS="--print --verbose"
export SKYNET_CLAUDE_MODEL=""
export SKYNET_AUTH_TOKEN_CACHE="$TMPDIR_ROOT/claude-token"
export SKYNET_AUTH_FAIL_FLAG="$TMPDIR_ROOT/auth-failed"

# Stub _agent_exec: just exec the command (no timeout wrapper needed in tests)
_agent_exec() { "$@"; }

# Source the plugin under test
source "$REPO_ROOT/scripts/agents/claude.sh"

echo "agent-claude.test.sh — unit tests for scripts/agents/claude.sh"

# ══════════════════════════════════════════════════════════════════════
# agent_check tests
# ══════════════════════════════════════════════════════════════════════

# ── agent_check: binary not found ─────────────────────────────────────

echo ""
log "=== agent_check: binary not found ==="

export SKYNET_CLAUDE_BIN="nonexistent-claude-binary-$$"
rm -f "$SKYNET_AUTH_TOKEN_CACHE" "$SKYNET_AUTH_FAIL_FLAG"

if agent_check 2>/dev/null; then
  fail "agent_check: should return 1 when binary not found"
else
  pass "agent_check: returns 1 when binary not found"
fi

# ── agent_check: binary found, no token cache, no fail flag ───────────

echo ""
log "=== agent_check: binary found, no cache, no fail flag ==="

# Create a mock claude binary
cat > "$MOCK_BIN/mock-claude" <<'MOCK'
#!/usr/bin/env bash
exit 0
MOCK
chmod +x "$MOCK_BIN/mock-claude"
export PATH="$MOCK_BIN:$ORIG_PATH"
export SKYNET_CLAUDE_BIN="mock-claude"

rm -f "$SKYNET_AUTH_TOKEN_CACHE" "$SKYNET_AUTH_FAIL_FLAG"

if agent_check 2>/dev/null; then
  pass "agent_check: returns 0 when binary found, no cache, no fail flag (optimistic)"
else
  fail "agent_check: should return 0 optimistically when binary found"
fi

# ── agent_check: binary found, valid token in cache ───────────────────

echo ""
log "=== agent_check: valid token in cache ==="

echo "sk-valid-token-12345" > "$SKYNET_AUTH_TOKEN_CACHE"
rm -f "$SKYNET_AUTH_FAIL_FLAG"

if agent_check 2>/dev/null; then
  pass "agent_check: returns 0 when valid token in cache"
else
  fail "agent_check: should return 0 when valid token exists"
fi

# ── agent_check: binary found, empty token in cache ───────────────────

echo ""
log "=== agent_check: empty token in cache ==="

: > "$SKYNET_AUTH_TOKEN_CACHE"  # empty file
rm -f "$SKYNET_AUTH_FAIL_FLAG"

if agent_check 2>/dev/null; then
  pass "agent_check: returns 0 when empty token (falls through to optimistic)"
else
  fail "agent_check: should return 0 optimistically with empty token"
fi

# ── agent_check: auth fail flag present ───────────────────────────────

echo ""
log "=== agent_check: auth fail flag present ==="

rm -f "$SKYNET_AUTH_TOKEN_CACHE"
touch "$SKYNET_AUTH_FAIL_FLAG"

if agent_check 2>/dev/null; then
  fail "agent_check: should return 1 when auth fail flag is present"
else
  pass "agent_check: returns 1 when auth fail flag is present"
fi

# ── agent_check: token cache takes priority over fail flag ────────────

echo ""
log "=== agent_check: token cache overrides fail flag ==="

echo "sk-valid-token-12345" > "$SKYNET_AUTH_TOKEN_CACHE"
touch "$SKYNET_AUTH_FAIL_FLAG"

if agent_check 2>/dev/null; then
  pass "agent_check: returns 0 — valid token cache overrides fail flag"
else
  fail "agent_check: should return 0 when valid token exists despite fail flag"
fi

# ── agent_check: token cache file missing, no fail flag ───────────────

echo ""
log "=== agent_check: no token cache file, no fail flag ==="

rm -f "$SKYNET_AUTH_TOKEN_CACHE" "$SKYNET_AUTH_FAIL_FLAG"

if agent_check 2>/dev/null; then
  pass "agent_check: returns 0 optimistically (no cache, no fail flag)"
else
  fail "agent_check: should return 0 optimistically"
fi

# ══════════════════════════════════════════════════════════════════════
# agent_run tests
# ══════════════════════════════════════════════════════════════════════

echo ""
log "=== agent_run: prompt piping and log output ==="

# Create a mock claude binary that captures stdin and args
cat > "$MOCK_BIN/mock-claude" <<'MOCK'
#!/usr/bin/env bash
echo "ARGS: $*"
echo "STDIN: $(cat)"
exit 0
MOCK
chmod +x "$MOCK_BIN/mock-claude"
export PATH="$MOCK_BIN:$ORIG_PATH"
export SKYNET_CLAUDE_BIN="mock-claude"
export SKYNET_CLAUDE_FLAGS="--print --verbose"
export SKYNET_CLAUDE_MODEL=""

# Test 1: prompt is piped via stdin
log_file="$TMPDIR_ROOT/run-test.log"
agent_run "hello world" "$log_file"
rc=$?
assert_eq "$rc" "0" "agent_run: exits 0 on success"

log_content=$(cat "$log_file")
assert_contains "$log_content" "STDIN: hello world" "agent_run: prompt piped via stdin"
assert_contains "$log_content" "--print" "agent_run: SKYNET_CLAUDE_FLAGS passed"
assert_contains "$log_content" "--verbose" "agent_run: all flags passed"

# ── agent_run: model flag added when SKYNET_CLAUDE_MODEL is set ───────

echo ""
log "=== agent_run: model flag ==="

export SKYNET_CLAUDE_MODEL="claude-sonnet-4-20250514"
log_file="$TMPDIR_ROOT/model-test.log"
agent_run "test prompt" "$log_file"

log_content=$(cat "$log_file")
assert_contains "$log_content" "--model claude-sonnet-4-20250514" "agent_run: --model flag added when SKYNET_CLAUDE_MODEL set"

# ── agent_run: no model flag when SKYNET_CLAUDE_MODEL is empty ────────

echo ""
log "=== agent_run: no model flag when empty ==="

export SKYNET_CLAUDE_MODEL=""
log_file="$TMPDIR_ROOT/no-model-test.log"
agent_run "test prompt" "$log_file"

log_content=$(cat "$log_file")
if printf '%s' "$log_content" | grep -qF -- "--model"; then
  fail "agent_run: should not include --model when SKYNET_CLAUDE_MODEL is empty"
else
  pass "agent_run: no --model flag when SKYNET_CLAUDE_MODEL is empty"
fi

# ── agent_run: exit code is preserved ─────────────────────────────────

echo ""
log "=== agent_run: exit code preservation ==="

cat > "$MOCK_BIN/mock-claude" <<'MOCK'
#!/usr/bin/env bash
cat >/dev/null
exit 42
MOCK
chmod +x "$MOCK_BIN/mock-claude"

log_file="$TMPDIR_ROOT/exit-test.log"
agent_run "test" "$log_file"
rc=$?
assert_eq "$rc" "42" "agent_run: preserves non-zero exit code"

# ── agent_run: default log_file is /dev/null ──────────────────────────

echo ""
log "=== agent_run: default log_file ==="

cat > "$MOCK_BIN/mock-claude" <<'MOCK'
#!/usr/bin/env bash
cat >/dev/null
echo "output"
exit 0
MOCK
chmod +x "$MOCK_BIN/mock-claude"

# Call without log_file arg — should not error
agent_run "test"
rc=$?
assert_eq "$rc" "0" "agent_run: works without explicit log_file"

# ── agent_run: multiline prompt ───────────────────────────────────────

echo ""
log "=== agent_run: multiline prompt ==="

cat > "$MOCK_BIN/mock-claude" <<'MOCK'
#!/usr/bin/env bash
echo "STDIN: $(cat)"
exit 0
MOCK
chmod +x "$MOCK_BIN/mock-claude"

log_file="$TMPDIR_ROOT/multiline-test.log"
multiline_prompt="line one
line two
line three"
agent_run "$multiline_prompt" "$log_file"

log_content=$(cat "$log_file")
assert_contains "$log_content" "line one" "agent_run: multiline prompt line 1 piped"
assert_contains "$log_content" "line three" "agent_run: multiline prompt line 3 piped"

# ── agent_run: CLAUDECODE env var is unset ────────────────────────────

echo ""
log "=== agent_run: CLAUDECODE unset ==="

cat > "$MOCK_BIN/mock-claude" <<'MOCK'
#!/usr/bin/env bash
cat >/dev/null
if [ -z "${CLAUDECODE:-}" ]; then
  echo "CLAUDECODE_UNSET"
else
  echo "CLAUDECODE_SET=$CLAUDECODE"
fi
exit 0
MOCK
chmod +x "$MOCK_BIN/mock-claude"

export CLAUDECODE="should-be-removed"
log_file="$TMPDIR_ROOT/claudecode-test.log"
agent_run "test" "$log_file"

log_content=$(cat "$log_file")
assert_contains "$log_content" "CLAUDECODE_UNSET" "agent_run: CLAUDECODE env var is unset before execution"

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
