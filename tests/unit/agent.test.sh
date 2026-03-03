#!/usr/bin/env bash
# tests/unit/agent.test.sh — Unit tests for scripts/_agent.sh agent dispatch
#
# Tests: _resolve_plugin_path, _load_plugin_as, _check_prompt_size,
#        usage_limit_hit, _agent_exec, run_agent (auto mode fallback chain
#        + single plugin mode), backward compatibility
#
# Usage: bash tests/unit/agent.test.sh

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
    fail "$msg (expected to contain '$needle', got '$haystack')"
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
  if ! grep -q "$pattern" "$file" 2>/dev/null; then
    pass "$msg"
  else
    fail "$msg (pattern '$pattern' should not be in $file)"
  fi
}

# ── Setup: create isolated environment ──────────────────────────────

TMPDIR_ROOT=$(mktemp -d)
cleanup() { rm -rf "$TMPDIR_ROOT"; }
trap cleanup EXIT

# Create isolated directory structure
export SKYNET_SCRIPTS_DIR="$TMPDIR_ROOT/scripts"
export PROJECT_DIR="$TMPDIR_ROOT/project"
export DEV_DIR="$TMPDIR_ROOT/dev"
export SKYNET_PROJECT_NAME_UPPER="TEST"
export _CURRENT_TASK_TITLE="test-task"
export SKYNET_AGENT_TIMEOUT_MINUTES=0  # Disable timeout for testing

mkdir -p "$SKYNET_SCRIPTS_DIR/agents" "$PROJECT_DIR" "$DEV_DIR"

# Stub external functions
tg() { return 0; }

# Create mock agent plugins with env-var-controlled behavior.
# Function bodies reference env vars, so changing them alters behavior
# at call time without re-creating the plugin files.

cat > "$SKYNET_SCRIPTS_DIR/agents/claude.sh" << 'PLUGIN'
agent_check() {
  return ${MOCK_CLAUDE_CHECK_RC:-0}
}
agent_run() {
  local log_file="${2:-/dev/null}"
  if [ "${MOCK_CLAUDE_LIMIT:-0}" = "1" ]; then
    echo "You have hit your usage limit. Your limit resets at 3:00 pm." >> "$log_file"
    return 1
  fi
  return ${MOCK_CLAUDE_RUN_RC:-0}
}
PLUGIN

cat > "$SKYNET_SCRIPTS_DIR/agents/codex.sh" << 'PLUGIN'
agent_check() {
  return ${MOCK_CODEX_CHECK_RC:-0}
}
agent_run() {
  local log_file="${2:-/dev/null}"
  if [ "${MOCK_CODEX_LIMIT:-0}" = "1" ]; then
    echo "You have hit your usage limit. Your limit resets at 3:00 pm." >> "$log_file"
    return 1
  fi
  return ${MOCK_CODEX_RUN_RC:-0}
}
PLUGIN

cat > "$SKYNET_SCRIPTS_DIR/agents/gemini.sh" << 'PLUGIN'
agent_check() {
  return ${MOCK_GEMINI_CHECK_RC:-0}
}
agent_run() {
  local log_file="${2:-/dev/null}"
  if [ "${MOCK_GEMINI_LIMIT:-0}" = "1" ]; then
    echo "You have hit your usage limit. Your limit resets at 3:00 pm." >> "$log_file"
    return 1
  fi
  return ${MOCK_GEMINI_RUN_RC:-0}
}
PLUGIN

echo "agent.test.sh — unit tests for _agent.sh agent dispatch"

# Helper to reset mock state and re-source _agent.sh in auto mode
_reset_and_source() {
  export MOCK_CLAUDE_CHECK_RC=0 MOCK_CLAUDE_RUN_RC=0 MOCK_CLAUDE_LIMIT=0
  export MOCK_CODEX_CHECK_RC=0 MOCK_CODEX_RUN_RC=0 MOCK_CODEX_LIMIT=0
  export MOCK_GEMINI_CHECK_RC=0 MOCK_GEMINI_RUN_RC=0 MOCK_GEMINI_LIMIT=0
  export SKYNET_AGENT_PLUGIN="auto"
  export SKYNET_SCRIPTS_DIR="$TMPDIR_ROOT/scripts"
  unset -f run_agent 2>/dev/null || true
  source "$REPO_ROOT/scripts/_agent.sh"
}

# Initial source to get helper functions defined
_reset_and_source

# ── _resolve_plugin_path ──────────────────────────────────────────

echo ""
log "=== _resolve_plugin_path ==="

result=$(_resolve_plugin_path "claude")
assert_eq "$result" "$SKYNET_SCRIPTS_DIR/agents/claude.sh" "resolve: claude maps to agents/claude.sh"

result=$(_resolve_plugin_path "codex")
assert_eq "$result" "$SKYNET_SCRIPTS_DIR/agents/codex.sh" "resolve: codex maps to agents/codex.sh"

result=$(_resolve_plugin_path "gemini")
assert_eq "$result" "$SKYNET_SCRIPTS_DIR/agents/gemini.sh" "resolve: gemini maps to agents/gemini.sh"

result=$(_resolve_plugin_path "echo")
assert_eq "$result" "$SKYNET_SCRIPTS_DIR/agents/echo.sh" "resolve: echo maps to agents/echo.sh"

result=$(_resolve_plugin_path "auto")
assert_eq "$result" "auto" "resolve: auto returns literal 'auto'"

# Absolute path — returned as-is
touch "$TMPDIR_ROOT/custom-agent.sh"
result=$(_resolve_plugin_path "$TMPDIR_ROOT/custom-agent.sh")
assert_eq "$result" "$TMPDIR_ROOT/custom-agent.sh" "resolve: absolute path returned as-is"

# Relative path — resolves against PROJECT_DIR
touch "$PROJECT_DIR/my-agent.sh"
result=$(_resolve_plugin_path "my-agent.sh")
assert_eq "$result" "$PROJECT_DIR/my-agent.sh" "resolve: relative path resolves against PROJECT_DIR"

# ── _load_plugin_as ───────────────────────────────────────────────

echo ""
log "=== _load_plugin_as ==="

# Valid plugin — functions are renamed under prefix
cat > "$TMPDIR_ROOT/good-plugin.sh" << 'PLUG'
agent_check() { return 0; }
agent_run() { echo "good-plugin-ran" >> "${2:-/dev/null}"; return 0; }
PLUG

_load_plugin_as "_test" "$TMPDIR_ROOT/good-plugin.sh"

_test_agent_check
assert_eq "$?" "0" "load_plugin_as: valid plugin check returns 0"

local_log="$TMPDIR_ROOT/plug-test.log"
> "$local_log"
_test_agent_run "hello" "$local_log"
assert_eq "$?" "0" "load_plugin_as: valid plugin run returns 0"
assert_grep "$local_log" "good-plugin-ran" "load_plugin_as: plugin run wrote to log"

# Missing file — creates failing stubs
_load_plugin_as "_missing" "$TMPDIR_ROOT/no-such-plugin.sh"

_missing_agent_check
assert_eq "$?" "1" "load_plugin_as: missing file — check returns 1"

_missing_agent_run "hello" "/dev/null"
assert_eq "$?" "1" "load_plugin_as: missing file — run returns 1"

# Syntax error — creates failing stubs
cat > "$TMPDIR_ROOT/bad-syntax.sh" << 'PLUG'
agent_check() { return 0
# Missing closing brace
PLUG

_load_plugin_as "_badsyn" "$TMPDIR_ROOT/bad-syntax.sh"

_badsyn_agent_check
assert_eq "$?" "1" "load_plugin_as: syntax error — check returns 1"

# Plugin without agent_check — gets default (returns 0)
cat > "$TMPDIR_ROOT/no-check-plugin.sh" << 'PLUG'
agent_run() { return 0; }
PLUG

_load_plugin_as "_nocheck" "$TMPDIR_ROOT/no-check-plugin.sh"

_nocheck_agent_check
assert_eq "$?" "0" "load_plugin_as: missing agent_check — default returns 0"

# Invalid prefix — rejected
_load_plugin_as "bad-prefix!" "$TMPDIR_ROOT/good-plugin.sh" 2>/dev/null
assert_eq "$?" "1" "load_plugin_as: invalid prefix rejected"

# ── _check_prompt_size ────────────────────────────────────────────

echo ""
log "=== _check_prompt_size ==="

local_log="$TMPDIR_ROOT/prompt-size.log"

# Small prompt passes
> "$local_log"
_check_prompt_size "hello world" "$local_log"
assert_eq "$?" "0" "check_prompt_size: small prompt passes"

# Prompt exceeding hard limit — rejected
export SKYNET_PROMPT_MAX_BYTES=10
> "$local_log"
_check_prompt_size "this is definitely more than 10 bytes" "$local_log"
assert_eq "$?" "1" "check_prompt_size: prompt over hard limit rejected"
assert_grep "$local_log" "hard limit" "check_prompt_size: hard limit logged"

# Prompt exceeding soft limit — warns but passes
export SKYNET_PROMPT_WARN_BYTES=5
export SKYNET_PROMPT_MAX_BYTES=1000
> "$local_log"
_check_prompt_size "more than five" "$local_log"
assert_eq "$?" "0" "check_prompt_size: prompt over soft limit still passes"
assert_grep "$local_log" "WARNING" "check_prompt_size: soft limit warning logged"

# Hard limit disabled (0) — large prompt passes
export SKYNET_PROMPT_MAX_BYTES=0
export SKYNET_PROMPT_WARN_BYTES=0
> "$local_log"
_check_prompt_size "anything goes when max is zero" "$local_log"
assert_eq "$?" "0" "check_prompt_size: max=0 disables hard limit"

# Restore defaults
unset SKYNET_PROMPT_WARN_BYTES SKYNET_PROMPT_MAX_BYTES

# ── usage_limit_hit ───────────────────────────────────────────────

echo ""
log "=== usage_limit_hit ==="

local_log="$TMPDIR_ROOT/limit-test.log"

# Detects "usage limit" pattern
echo "You have hit your usage limit." > "$local_log"
usage_limit_hit "$local_log"
assert_eq "$?" "0" "usage_limit_hit: detects 'usage limit'"

# Detects "purchase more credits" pattern
echo "Please purchase more credits to continue." > "$local_log"
usage_limit_hit "$local_log"
assert_eq "$?" "0" "usage_limit_hit: detects 'purchase more credits'"

# Detects "resets at" time pattern
echo "Your limit resets at 3:00 pm." > "$local_log"
usage_limit_hit "$local_log"
assert_eq "$?" "0" "usage_limit_hit: detects 'resets at' time pattern"

# Detects "exhausted your capacity" pattern
echo "You have exhausted your capacity for today." > "$local_log"
usage_limit_hit "$local_log"
assert_eq "$?" "0" "usage_limit_hit: detects 'exhausted your capacity'"

# Detects "quota" pattern
echo "Your API quota has been exceeded." > "$local_log"
usage_limit_hit "$local_log"
assert_eq "$?" "0" "usage_limit_hit: detects 'quota'"

# No match returns 1
echo "Everything is working fine." > "$local_log"
usage_limit_hit "$local_log"
assert_eq "$?" "1" "usage_limit_hit: no match returns 1"

# Missing file returns 1
usage_limit_hit "$TMPDIR_ROOT/nonexistent.log"
assert_eq "$?" "1" "usage_limit_hit: missing file returns 1"

# Pattern must be in last 50 lines (older patterns ignored)
{
  echo "You have hit your usage limit."
  for _i in $(seq 1 60); do echo "normal log line $_i"; done
} > "$local_log"
usage_limit_hit "$local_log"
assert_eq "$?" "1" "usage_limit_hit: pattern >50 lines ago not detected"

# ── _agent_exec ───────────────────────────────────────────────────

echo ""
log "=== _agent_exec ==="

# Timeout disabled — command passes through
export SKYNET_AGENT_TIMEOUT_MINUTES=0
result=$(_agent_exec echo "hello-passthrough")
assert_eq "$?" "0" "_agent_exec: timeout=0 — command succeeds"
assert_eq "$result" "hello-passthrough" "_agent_exec: timeout=0 — output preserved"

# Failing command — exit code preserved
export SKYNET_AGENT_TIMEOUT_MINUTES=0
_agent_exec false
assert_eq "$?" "1" "_agent_exec: failing command — exit code preserved"

# With timeout enabled — fast command succeeds
export SKYNET_AGENT_TIMEOUT_MINUTES=1
result=$(_agent_exec echo "fast-cmd")
assert_eq "$?" "0" "_agent_exec: fast command succeeds with timeout"
assert_eq "$result" "fast-cmd" "_agent_exec: fast command output preserved"

# Restore
export SKYNET_AGENT_TIMEOUT_MINUTES=0

# ── run_agent (auto mode) ────────────────────────────────────────

echo ""
log "=== run_agent (auto mode): Claude succeeds ==="

_reset_and_source
> "$DEV_DIR/agent-metrics.log"
local_log="$TMPDIR_ROOT/auto-1.log"
> "$local_log"
run_agent "test prompt" "$local_log"
assert_eq "$?" "0" "Claude succeeds on first try — returns 0"
assert_grep "$DEV_DIR/agent-metrics.log" "agent=claude" "Claude success logged to metrics"

echo ""
log "=== run_agent (auto mode): Claude fails → Codex succeeds ==="

_reset_and_source
export MOCK_CLAUDE_RUN_RC=1
> "$DEV_DIR/agent-metrics.log"
local_log="$TMPDIR_ROOT/auto-2.log"
> "$local_log"
run_agent "test prompt" "$local_log"
assert_eq "$?" "0" "Claude fails, Codex fallback succeeds — returns 0"
assert_grep "$local_log" "falling back to Codex" "Codex fallback logged"
assert_grep "$DEV_DIR/agent-metrics.log" "agent=codex.*fallback_from=claude" "Codex fallback metrics logged"

echo ""
log "=== run_agent (auto mode): Claude + Codex fail → Gemini succeeds ==="

_reset_and_source
export MOCK_CLAUDE_RUN_RC=1
export MOCK_CODEX_RUN_RC=1
> "$DEV_DIR/agent-metrics.log"
local_log="$TMPDIR_ROOT/auto-3.log"
> "$local_log"
run_agent "test prompt" "$local_log"
assert_eq "$?" "0" "Claude + Codex fail, Gemini succeeds — returns 0"
assert_grep "$local_log" "falling back to Gemini" "Gemini fallback logged"
assert_grep "$DEV_DIR/agent-metrics.log" "agent=gemini" "Gemini success metrics logged"

echo ""
log "=== run_agent (auto mode): all agents fail (non-limit) ==="

_reset_and_source
export MOCK_CLAUDE_RUN_RC=1
export MOCK_CODEX_RUN_RC=2
export MOCK_GEMINI_RUN_RC=3
local_log="$TMPDIR_ROOT/auto-4.log"
> "$local_log"
run_agent "test prompt" "$local_log"
assert_eq "$?" "3" "All agents fail (non-limit) — returns last agent exit code"

echo ""
log "=== run_agent (auto mode): all agents hit usage limits → 125 ==="

_reset_and_source
export MOCK_CLAUDE_LIMIT=1
export MOCK_CODEX_LIMIT=1
export MOCK_GEMINI_LIMIT=1
local_log="$TMPDIR_ROOT/auto-5.log"
> "$local_log"
run_agent "test prompt" "$local_log"
assert_eq "$?" "125" "All agents hit usage limits — returns 125"

echo ""
log "=== run_agent (auto mode): Claude limited, Codex unavailable, Gemini succeeds ==="

_reset_and_source
export MOCK_CLAUDE_LIMIT=1
export MOCK_CODEX_CHECK_RC=1
> "$DEV_DIR/agent-metrics.log"
local_log="$TMPDIR_ROOT/auto-6.log"
> "$local_log"
run_agent "test prompt" "$local_log"
assert_eq "$?" "0" "Claude limited, Codex unavailable, Gemini succeeds — returns 0"
assert_grep "$DEV_DIR/agent-metrics.log" "agent=gemini.*fallback_from=claude" "Gemini fallback from Claude logged"

echo ""
log "=== run_agent (auto mode): all agents unavailable ==="

_reset_and_source
export MOCK_CLAUDE_CHECK_RC=1
export MOCK_CODEX_CHECK_RC=1
export MOCK_GEMINI_CHECK_RC=1
local_log="$TMPDIR_ROOT/auto-7.log"
> "$local_log"
run_agent "test prompt" "$local_log"
assert_eq "$?" "1" "All agents unavailable — returns 1"
assert_grep "$local_log" "No AI agent available" "No-agent error logged"

echo ""
log "=== run_agent (auto mode): Claude unavailable → Codex succeeds ==="

_reset_and_source
export MOCK_CLAUDE_CHECK_RC=1
> "$DEV_DIR/agent-metrics.log"
local_log="$TMPDIR_ROOT/auto-8.log"
> "$local_log"
run_agent "test prompt" "$local_log"
assert_eq "$?" "0" "Claude unavailable, Codex succeeds — returns 0"
assert_grep "$local_log" "Claude unavailable" "Claude unavailable logged"
assert_grep "$DEV_DIR/agent-metrics.log" "agent=codex.*fallback_from=claude" "Codex fallback metrics logged"

echo ""
log "=== run_agent (auto mode): Claude unavailable, Codex + Gemini limited → 125 ==="

_reset_and_source
export MOCK_CLAUDE_CHECK_RC=1
export MOCK_CODEX_LIMIT=1
export MOCK_GEMINI_LIMIT=1
local_log="$TMPDIR_ROOT/auto-9.log"
> "$local_log"
run_agent "test prompt" "$local_log"
assert_eq "$?" "125" "Claude unavailable, Codex + Gemini limited — returns 125"

echo ""
log "=== run_agent (auto mode): Claude limited → Codex succeeds ==="

_reset_and_source
export MOCK_CLAUDE_LIMIT=1
> "$DEV_DIR/agent-metrics.log"
local_log="$TMPDIR_ROOT/auto-10.log"
> "$local_log"
run_agent "test prompt" "$local_log"
assert_eq "$?" "0" "Claude limited, Codex succeeds — returns 0"
assert_grep "$DEV_DIR/agent-metrics.log" "agent=codex.*fallback_from=claude" "Codex fallback metrics logged"

echo ""
log "=== run_agent (auto mode): Claude + Codex limited, Gemini unavailable → 125 ==="

_reset_and_source
export MOCK_CLAUDE_LIMIT=1
export MOCK_CODEX_LIMIT=1
export MOCK_GEMINI_CHECK_RC=1
local_log="$TMPDIR_ROOT/auto-11.log"
> "$local_log"
run_agent "test prompt" "$local_log"
assert_eq "$?" "125" "Claude + Codex limited, Gemini unavailable — returns 125"

echo ""
log "=== run_agent (auto mode): prompt too large → rejected ==="

_reset_and_source
export SKYNET_PROMPT_MAX_BYTES=5
local_log="$TMPDIR_ROOT/auto-12.log"
> "$local_log"
run_agent "this prompt is way too large" "$local_log"
assert_eq "$?" "1" "Prompt too large — returns 1 before agent call"
assert_grep "$local_log" "hard limit" "Prompt rejection logged"
unset SKYNET_PROMPT_MAX_BYTES

echo ""
log "=== run_agent (auto mode): Claude unavailable, Codex unavailable → Gemini ==="

_reset_and_source
export MOCK_CLAUDE_CHECK_RC=1
export MOCK_CODEX_CHECK_RC=1
> "$DEV_DIR/agent-metrics.log"
local_log="$TMPDIR_ROOT/auto-13.log"
> "$local_log"
run_agent "test prompt" "$local_log"
assert_eq "$?" "0" "Claude + Codex unavailable, Gemini succeeds — returns 0"
assert_grep "$local_log" "Claude + Codex unavailable" "Both unavailable logged"
assert_grep "$DEV_DIR/agent-metrics.log" "agent=gemini" "Gemini success metrics logged"

# ── run_agent (single plugin mode) ───────────────────────────────

echo ""
log "=== run_agent (single plugin mode) ==="

# Create a controllable single-mode plugin
cat > "$TMPDIR_ROOT/single-plugin.sh" << 'PLUG'
agent_check() {
  return ${MOCK_SINGLE_CHECK_RC:-0}
}
agent_run() {
  local log_file="${2:-/dev/null}"
  echo "single-plugin-ran" >> "$log_file"
  return ${MOCK_SINGLE_RUN_RC:-0}
}
PLUG

# Plugin succeeds
export MOCK_SINGLE_CHECK_RC=0 MOCK_SINGLE_RUN_RC=0
export SKYNET_AGENT_PLUGIN="$TMPDIR_ROOT/single-plugin.sh"
unset -f run_agent 2>/dev/null || true
source "$REPO_ROOT/scripts/_agent.sh"

local_log="$TMPDIR_ROOT/single-1.log"
> "$local_log"
run_agent "test prompt" "$local_log"
assert_eq "$?" "0" "single: plugin succeeds — returns 0"
assert_grep "$local_log" "single-plugin-ran" "single: plugin actually ran"

# Plugin fails — exit code forwarded
export MOCK_SINGLE_RUN_RC=42
local_log="$TMPDIR_ROOT/single-2.log"
> "$local_log"
run_agent "test prompt" "$local_log"
assert_eq "$?" "42" "single: plugin fails — returns agent exit code"

# Agent unavailable (agent_check fails)
export MOCK_SINGLE_CHECK_RC=1
export MOCK_SINGLE_RUN_RC=0
export SKYNET_AGENT_PLUGIN="$TMPDIR_ROOT/single-plugin.sh"
unset -f run_agent 2>/dev/null || true
source "$REPO_ROOT/scripts/_agent.sh"

local_log="$TMPDIR_ROOT/single-3.log"
> "$local_log"
run_agent "test prompt" "$local_log"
assert_eq "$?" "1" "single: agent unavailable — returns 1"
assert_grep "$local_log" "Agent not available" "single: unavailability logged"

# Prompt too large in single mode
export MOCK_SINGLE_CHECK_RC=0
export SKYNET_AGENT_PLUGIN="$TMPDIR_ROOT/single-plugin.sh"
unset -f run_agent 2>/dev/null || true
source "$REPO_ROOT/scripts/_agent.sh"

export SKYNET_PROMPT_MAX_BYTES=5
local_log="$TMPDIR_ROOT/single-4.log"
> "$local_log"
run_agent "very long prompt here" "$local_log"
assert_eq "$?" "1" "single: prompt too large — returns 1"
unset SKYNET_PROMPT_MAX_BYTES

# Missing plugin file — exit 1 (test in subshell)
(
  export SKYNET_AGENT_PLUGIN="$TMPDIR_ROOT/no-such-file.sh"
  unset -f run_agent 2>/dev/null || true
  source "$REPO_ROOT/scripts/_agent.sh" 2>/dev/null
)
assert_eq "$?" "1" "single: missing plugin file — exit 1"

# ── backward compatibility ────────────────────────────────────────

echo ""
log "=== backward compatibility ==="

# SKYNET_AGENT_PREFERENCE maps to SKYNET_AGENT_PLUGIN when plugin=auto
export SKYNET_AGENT_PLUGIN="auto"
export SKYNET_AGENT_PREFERENCE="echo"
export SKYNET_SCRIPTS_DIR="$REPO_ROOT/scripts"  # need real echo.sh
unset -f run_agent 2>/dev/null || true
source "$REPO_ROOT/scripts/_agent.sh"

assert_eq "$SKYNET_AGENT_PLUGIN" "echo" "compat: SKYNET_AGENT_PREFERENCE maps to SKYNET_AGENT_PLUGIN"
unset SKYNET_AGENT_PREFERENCE

# Restore scripts dir for any further testing
export SKYNET_SCRIPTS_DIR="$TMPDIR_ROOT/scripts"

# ── Summary ──────────────────────────────────────────────────────

echo ""
TOTAL=$((PASS + FAIL))
log "Results: $PASS/$TOTAL passed, $FAIL failed"
if [ "$FAIL" -eq 0 ]; then
  printf "  \033[32mAll checks passed!\033[0m\n"
else
  printf "  \033[31mSome checks failed!\033[0m\n"
  exit 1
fi
