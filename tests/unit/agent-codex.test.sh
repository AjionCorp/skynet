#!/usr/bin/env bash
# tests/unit/agent-codex.test.sh — Unit tests for scripts/agents/codex.sh
#
# Tests: agent_check (binary detection, auth fail flag, OPENAI_API_KEY, auth file),
#        agent_run (prompt piping, model flag, subcommand, log output)
#
# Usage: bash tests/unit/agent-codex.test.sh

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

# Set up env vars expected by codex.sh
export SKYNET_CODEX_BIN="mock-codex"
export SKYNET_CODEX_FLAGS="--full-auto"
export SKYNET_CODEX_MODEL=""
export SKYNET_CODEX_SUBCOMMAND=""
export SKYNET_CODEX_AUTH_FILE="$TMPDIR_ROOT/.codex/auth.json"
export SKYNET_CODEX_AUTH_FAIL_FLAG="$TMPDIR_ROOT/codex-auth-failed"
# Ensure HOME doesn't interfere with auth file checks
export HOME="$TMPDIR_ROOT"

# Stub _agent_exec: just exec the command (no timeout wrapper needed in tests)
_agent_exec() { "$@"; }

# Source the plugin under test
source "$REPO_ROOT/scripts/agents/codex.sh"

echo "agent-codex.test.sh — unit tests for scripts/agents/codex.sh"

# ══════════════════════════════════════════════════════════════════════
# agent_check tests
# ══════════════════════════════════════════════════════════════════════

# ── agent_check: binary not found ─────────────────────────────────────

echo ""
log "=== agent_check: binary not found ==="

export SKYNET_CODEX_BIN="nonexistent-codex-binary-$$"
rm -f "$SKYNET_CODEX_AUTH_FAIL_FLAG"
unset OPENAI_API_KEY 2>/dev/null || true

if agent_check 2>/dev/null; then
  fail "agent_check: should return 1 when binary not found"
else
  pass "agent_check: returns 1 when binary not found"
fi

# ── agent_check: binary found with OPENAI_API_KEY ─────────────────────

echo ""
log "=== agent_check: binary found with OPENAI_API_KEY ==="

cat > "$MOCK_BIN/mock-codex" <<'MOCK'
#!/usr/bin/env bash
exit 0
MOCK
chmod +x "$MOCK_BIN/mock-codex"
export PATH="$MOCK_BIN:$ORIG_PATH"
export SKYNET_CODEX_BIN="mock-codex"

rm -f "$SKYNET_CODEX_AUTH_FAIL_FLAG"
export OPENAI_API_KEY="sk-test-key-123"

if agent_check 2>/dev/null; then
  pass "agent_check: returns 0 with OPENAI_API_KEY set"
else
  fail "agent_check: should return 0 with OPENAI_API_KEY set"
fi

# ── agent_check: binary found with auth file ──────────────────────────

echo ""
log "=== agent_check: binary found with auth file ==="

unset OPENAI_API_KEY 2>/dev/null || true
rm -f "$SKYNET_CODEX_AUTH_FAIL_FLAG"

# Create auth file
mkdir -p "$TMPDIR_ROOT/.codex"
echo '{"token":"sk-test"}' > "$TMPDIR_ROOT/.codex/auth.json"
export SKYNET_CODEX_AUTH_FILE="$TMPDIR_ROOT/.codex/auth.json"

if agent_check 2>/dev/null; then
  pass "agent_check: returns 0 with valid auth file"
else
  fail "agent_check: should return 0 with valid auth file"
fi

# ── agent_check: no auth available ────────────────────────────────────

echo ""
log "=== agent_check: no auth available ==="

unset OPENAI_API_KEY 2>/dev/null || true
rm -f "$SKYNET_CODEX_AUTH_FAIL_FLAG"
rm -f "$TMPDIR_ROOT/.codex/auth.json"
# Also ensure default path doesn't exist
export SKYNET_CODEX_AUTH_FILE="$TMPDIR_ROOT/nonexistent-auth.json"

if agent_check 2>/dev/null; then
  fail "agent_check: should return 1 when no auth available"
else
  pass "agent_check: returns 1 when no auth (no key, no auth file)"
fi

# ── agent_check: auth fail flag blocks ────────────────────────────────

echo ""
log "=== agent_check: auth fail flag blocks ==="

export OPENAI_API_KEY="sk-test-key-123"
touch "$SKYNET_CODEX_AUTH_FAIL_FLAG"

if agent_check 2>/dev/null; then
  fail "agent_check: should return 1 when auth fail flag is present"
else
  pass "agent_check: returns 1 when auth fail flag present (even with API key)"
fi

rm -f "$SKYNET_CODEX_AUTH_FAIL_FLAG"

# ── agent_check: empty auth file is not valid ─────────────────────────

echo ""
log "=== agent_check: empty auth file ==="

unset OPENAI_API_KEY 2>/dev/null || true
rm -f "$SKYNET_CODEX_AUTH_FAIL_FLAG"
: > "$TMPDIR_ROOT/.codex/auth.json"  # empty file
export SKYNET_CODEX_AUTH_FILE="$TMPDIR_ROOT/.codex/auth.json"

if agent_check 2>/dev/null; then
  fail "agent_check: should return 1 with empty auth file"
else
  pass "agent_check: returns 1 when auth file is empty (-s check fails)"
fi

# ── agent_check: default auth file path ($HOME/.codex/auth.json) ──────

echo ""
log "=== agent_check: default auth file fallback ==="

unset OPENAI_API_KEY 2>/dev/null || true
rm -f "$SKYNET_CODEX_AUTH_FAIL_FLAG"
unset SKYNET_CODEX_AUTH_FILE 2>/dev/null || true

# Create auth file at default location ($HOME/.codex/auth.json)
mkdir -p "$TMPDIR_ROOT/.codex"
echo '{"token":"sk-default"}' > "$TMPDIR_ROOT/.codex/auth.json"

if agent_check 2>/dev/null; then
  pass "agent_check: returns 0 with default auth file path"
else
  fail "agent_check: should find auth file at \$HOME/.codex/auth.json"
fi

# ══════════════════════════════════════════════════════════════════════
# agent_run tests
# ══════════════════════════════════════════════════════════════════════

echo ""
log "=== agent_run: prompt piping and subcommand ==="

# Create a mock codex binary that captures stdin and args
cat > "$MOCK_BIN/mock-codex" <<'MOCK'
#!/usr/bin/env bash
echo "ARGS: $*"
echo "STDIN: $(cat)"
exit 0
MOCK
chmod +x "$MOCK_BIN/mock-codex"
export PATH="$MOCK_BIN:$ORIG_PATH"
export SKYNET_CODEX_BIN="mock-codex"
export SKYNET_CODEX_FLAGS="--full-auto"
export SKYNET_CODEX_MODEL=""
export SKYNET_CODEX_SUBCOMMAND=""

# Test 1: prompt is piped via stdin, default subcommand is "exec"
log_file="$TMPDIR_ROOT/run-test.log"
agent_run "hello codex" "$log_file"
rc=$?
assert_eq "$rc" "0" "agent_run: exits 0 on success"

log_content=$(cat "$log_file")
assert_contains "$log_content" "STDIN: hello codex" "agent_run: prompt piped via stdin"
assert_contains "$log_content" "exec" "agent_run: default subcommand is 'exec'"
assert_contains "$log_content" "--full-auto" "agent_run: SKYNET_CODEX_FLAGS passed"

# ── agent_run: custom subcommand ──────────────────────────────────────

echo ""
log "=== agent_run: custom subcommand ==="

export SKYNET_CODEX_SUBCOMMAND="run"
log_file="$TMPDIR_ROOT/subcmd-test.log"
agent_run "test prompt" "$log_file"

log_content=$(cat "$log_file")
assert_contains "$log_content" "run" "agent_run: custom subcommand 'run' used"

export SKYNET_CODEX_SUBCOMMAND=""

# ── agent_run: model flag added when SKYNET_CODEX_MODEL is set ────────

echo ""
log "=== agent_run: model flag ==="

export SKYNET_CODEX_MODEL="gpt-4o"
log_file="$TMPDIR_ROOT/model-test.log"
agent_run "test prompt" "$log_file"

log_content=$(cat "$log_file")
assert_contains "$log_content" "--model gpt-4o" "agent_run: --model flag added when SKYNET_CODEX_MODEL set"

# ── agent_run: no model flag when SKYNET_CODEX_MODEL is empty ─────────

echo ""
log "=== agent_run: no model flag when empty ==="

export SKYNET_CODEX_MODEL=""
log_file="$TMPDIR_ROOT/no-model-test.log"
agent_run "test prompt" "$log_file"

log_content=$(cat "$log_file")
if printf '%s' "$log_content" | grep -qF -- "--model"; then
  fail "agent_run: should not include --model when SKYNET_CODEX_MODEL is empty"
else
  pass "agent_run: no --model flag when SKYNET_CODEX_MODEL is empty"
fi

# ── agent_run: exit code is preserved ─────────────────────────────────

echo ""
log "=== agent_run: exit code preservation ==="

cat > "$MOCK_BIN/mock-codex" <<'MOCK'
#!/usr/bin/env bash
cat >/dev/null
exit 77
MOCK
chmod +x "$MOCK_BIN/mock-codex"

log_file="$TMPDIR_ROOT/exit-test.log"
agent_run "test" "$log_file"
rc=$?
assert_eq "$rc" "77" "agent_run: preserves non-zero exit code"

# ── agent_run: default log_file is /dev/null ──────────────────────────

echo ""
log "=== agent_run: default log_file ==="

cat > "$MOCK_BIN/mock-codex" <<'MOCK'
#!/usr/bin/env bash
cat >/dev/null
echo "output"
exit 0
MOCK
chmod +x "$MOCK_BIN/mock-codex"

# Call without log_file arg — should not error
agent_run "test"
rc=$?
assert_eq "$rc" "0" "agent_run: works without explicit log_file"

# ── agent_run: multiline prompt ───────────────────────────────────────

echo ""
log "=== agent_run: multiline prompt ==="

cat > "$MOCK_BIN/mock-codex" <<'MOCK'
#!/usr/bin/env bash
echo "STDIN: $(cat)"
exit 0
MOCK
chmod +x "$MOCK_BIN/mock-codex"

log_file="$TMPDIR_ROOT/multiline-test.log"
multiline_prompt="line one
line two
line three"
agent_run "$multiline_prompt" "$log_file"

log_content=$(cat "$log_file")
assert_contains "$log_content" "line one" "agent_run: multiline prompt line 1 piped"
assert_contains "$log_content" "line three" "agent_run: multiline prompt line 3 piped"

# ── agent_run: all components together ────────────────────────────────

echo ""
log "=== agent_run: full invocation with all options ==="

cat > "$MOCK_BIN/mock-codex" <<'MOCK'
#!/usr/bin/env bash
echo "ARGS: $*"
echo "STDIN: $(cat)"
exit 0
MOCK
chmod +x "$MOCK_BIN/mock-codex"

export SKYNET_CODEX_FLAGS="--full-auto --quiet"
export SKYNET_CODEX_MODEL="o3-mini"
export SKYNET_CODEX_SUBCOMMAND="execute"

log_file="$TMPDIR_ROOT/full-test.log"
agent_run "do the thing" "$log_file"

log_content=$(cat "$log_file")
assert_contains "$log_content" "execute" "agent_run: subcommand in args"
assert_contains "$log_content" "--full-auto" "agent_run: flags in args"
assert_contains "$log_content" "--quiet" "agent_run: all flags in args"
assert_contains "$log_content" "--model o3-mini" "agent_run: model flag in args"
assert_contains "$log_content" "STDIN: do the thing" "agent_run: prompt in stdin"

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
