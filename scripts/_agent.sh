#!/usr/bin/env bash
# _agent.sh — AI agent abstraction layer (plugin-based)
# Sourced by _config.sh — provides run_agent() to all scripts.
#
# Plugin interface: each agent plugin must define two functions:
#   agent_check              — returns 0 if agent is available, 1 if not
#   agent_run "prompt" "log" — runs the agent, returns exit code
#
# Set SKYNET_AGENT_PLUGIN in skynet.config.sh to:
#   "auto"                — try Claude first, fall back to Codex (default)
#   "claude"              — use Claude Code only
#   "codex"               — use Codex CLI only
#   "echo"                — dry-run (no LLM, creates placeholder commit)
#   "/path/to/plugin.sh"  — use a custom agent plugin

# Codex CLI defaults (override in skynet.config.sh)
export SKYNET_CODEX_BIN="${SKYNET_CODEX_BIN:-codex}"
export SKYNET_CODEX_FLAGS="${SKYNET_CODEX_FLAGS:---full-auto}"

# Agent timeout (default: 45 minutes, 0 = disabled)
export SKYNET_AGENT_TIMEOUT_MINUTES="${SKYNET_AGENT_TIMEOUT_MINUTES:-45}"

# Portable timeout wrapper for agent binary invocations.
# Usage: _agent_exec command [args...]
# On Linux, uses GNU coreutils `timeout` (returns 124 on timeout).
# On macOS, uses `perl -e 'alarm shift; exec @ARGV'` (bash 3.2 compatible,
# no GNU coreutils dependency). SIGALRM exit code (142) is normalized to 124.
# Set SKYNET_AGENT_TIMEOUT_MINUTES=0 to disable.
_agent_exec() {
  local timeout_secs=$(( SKYNET_AGENT_TIMEOUT_MINUTES * 60 ))

  if [ "$timeout_secs" -le 0 ]; then
    "$@"
    return $?
  fi

  if command -v timeout &>/dev/null; then
    # Linux: GNU coreutils timeout (returns 124 on timeout)
    timeout "$timeout_secs" "$@"
    return $?
  fi

  # macOS: perl alarm (bash 3.2 compatible, no GNU coreutils dependency)
  perl -e 'alarm shift; exec @ARGV' "$timeout_secs" "$@"
  local rc=$?
  # SIGALRM (signal 14) → exit 142 (128+14). Normalize to 124.
  [ "$rc" -eq 142 ] && return 124
  return "$rc"
}

# Agent plugin selection (default: auto)
export SKYNET_AGENT_PLUGIN="${SKYNET_AGENT_PLUGIN:-auto}"

# Backward compatibility: SKYNET_AGENT_PREFERENCE maps to SKYNET_AGENT_PLUGIN
if [ "${SKYNET_AGENT_PLUGIN}" = "auto" ] && [ "${SKYNET_AGENT_PREFERENCE:-auto}" != "auto" ]; then
  SKYNET_AGENT_PLUGIN="${SKYNET_AGENT_PREFERENCE}"
fi

# Resolve built-in plugin name to file path
_resolve_plugin_path() {
  local name="$1"
  case "$name" in
    claude|codex|echo) echo "$SKYNET_SCRIPTS_DIR/agents/${name}.sh" ;;
    auto)         echo "auto" ;;
    *)            # file path — resolve relative paths against $PROJECT_DIR
                  if [ -f "$PROJECT_DIR/$name" ]; then
                    echo "$PROJECT_DIR/$name"
                  elif [ -f "$name" ]; then
                    echo "$name"
                  else
                    echo "$name"
                  fi ;;
  esac
}

# Load a plugin and rename its functions under a prefix.
# Usage: _load_plugin_as "prefix" "/path/to/plugin.sh"
# Creates: prefix_agent_run(), prefix_agent_check()
_load_plugin_as() {
  local prefix="$1"
  local plugin_path="$2"

  if [ ! -f "$plugin_path" ]; then
    eval "${prefix}_agent_check() { return 1; }"
    eval "${prefix}_agent_run() { echo \"[\$(date '+%Y-%m-%d %H:%M:%S')] ERROR: Agent plugin not found: $plugin_path\" >> \"\${2:-/dev/null}\"; return 1; }"
    return
  fi

  # Source the plugin (defines agent_run + agent_check)
  # shellcheck source=/dev/null
  source "$plugin_path"

  # Default agent_check if plugin doesn't define one
  if ! declare -f agent_check &>/dev/null; then
    agent_check() { return 0; }
  fi

  # Rename into prefixed functions
  eval "$(declare -f agent_check | sed "1s/agent_check/${prefix}_agent_check/")"
  eval "$(declare -f agent_run | sed "1s/agent_run/${prefix}_agent_run/")"

  # Clean up generic names to avoid collisions with next plugin
  unset -f agent_check agent_run 2>/dev/null || true
}

# --- Set up run_agent() based on SKYNET_AGENT_PLUGIN ---

_plugin_resolved="$(_resolve_plugin_path "$SKYNET_AGENT_PLUGIN")"

if [ "$_plugin_resolved" = "auto" ]; then
  # Auto mode: try Claude first, fall back to Codex
  _load_plugin_as "_claude" "$SKYNET_SCRIPTS_DIR/agents/claude.sh"
  _load_plugin_as "_codex" "$SKYNET_SCRIPTS_DIR/agents/codex.sh"

  # Public API: run_agent "prompt" "log_file"
  # Returns the exit code of whichever agent ran.
  run_agent() {
    local prompt="$1"
    local log_file="${2:-/dev/null}"

    # Try Claude first
    if _claude_agent_check; then
      _claude_agent_run "$prompt" "$log_file"
      local exit_code=$?
      if [ "$exit_code" -eq 0 ]; then
        return 0
      fi
      # Claude failed — try Codex as fallback
      if _codex_agent_check; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] Claude failed (exit $exit_code) — falling back to Codex CLI" >> "$log_file"
        tg "🔄 *$SKYNET_PROJECT_NAME_UPPER*: Claude failed — switching to Codex" 2>/dev/null || true
        _codex_agent_run "$prompt" "$log_file"
        return $?
      fi
      return $exit_code
    fi

    # Claude unavailable — try Codex
    if _codex_agent_check; then
      echo "[$(date '+%Y-%m-%d %H:%M:%S')] Claude unavailable — falling back to Codex CLI" >> "$log_file"
      tg "🔄 *$SKYNET_PROJECT_NAME_UPPER*: Claude down — switching to Codex" 2>/dev/null || true
      _codex_agent_run "$prompt" "$log_file"
      return $?
    fi

    echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: No AI agent available (Claude auth failed, Codex not installed)" >> "$log_file"
    return 1
  }

else
  # Single plugin mode (built-in or custom file path)
  if [ ! -f "$_plugin_resolved" ]; then
    echo "FATAL: Agent plugin not found: $_plugin_resolved (SKYNET_AGENT_PLUGIN=$SKYNET_AGENT_PLUGIN)" >&2
    exit 1
  fi

  # shellcheck source=/dev/null
  source "$_plugin_resolved"

  # Default agent_check if plugin doesn't define one
  if ! declare -f agent_check &>/dev/null; then
    agent_check() { return 0; }
  fi

  # Public API: run_agent "prompt" "log_file"
  run_agent() {
    local prompt="$1"
    local log_file="${2:-/dev/null}"

    if ! agent_check; then
      echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: Agent not available (plugin: $SKYNET_AGENT_PLUGIN)" >> "$log_file"
      return 1
    fi

    agent_run "$prompt" "$log_file"
  }
fi

unset _plugin_resolved
