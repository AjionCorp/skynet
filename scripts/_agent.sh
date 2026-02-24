#!/usr/bin/env bash
# _agent.sh — AI agent abstraction layer (plugin-based)
# Sourced by _config.sh — provides run_agent() to all scripts.
#
# Plugin interface: each agent plugin must define two functions:
#   agent_check              — returns 0 if agent is available, 1 if not
#   agent_run "prompt" "log" — runs the agent, returns exit code
#
# Set SKYNET_AGENT_PLUGIN in skynet.config.sh to:
#   "auto"                — try Claude first, fall back to Codex, then Gemini (default)
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
  if [ -n "${SKYNET_AGENT_TIMEOUT_MINUTES:-}" ]; then
    case "$SKYNET_AGENT_TIMEOUT_MINUTES" in
      ''|*[!0-9]*) echo "[WARN] SKYNET_AGENT_TIMEOUT_MINUTES is non-numeric: '$SKYNET_AGENT_TIMEOUT_MINUTES'" >&2 ;;
    esac
  fi
  local timeout_secs=$(( SKYNET_AGENT_TIMEOUT_MINUTES * 60 ))

  if [ "$timeout_secs" -le 0 ]; then
    "$@"
    return $?
  fi

  if command -v timeout >/dev/null 2>&1; then
    # Linux: GNU coreutils timeout (returns 124 on timeout).
    # OPS-P1-6: --kill-after=30 sends SIGKILL 30s after the initial SIGTERM,
    # ensuring child processes (git, node) are force-killed even if they ignore SIGTERM.
    if timeout --kill-after=1 0 true 2>/dev/null; then
      timeout --kill-after=30 "$timeout_secs" "$@"
    else
      # Older timeout without --kill-after support — fall through to perl
      timeout "$timeout_secs" "$@"
    fi
    return $?
  fi

  # macOS: perl-based timeout with SIGKILL escalation (bash 3.2 compatible).
  # OPS-P1-6: After SIGTERM timeout, waits 30s then sends SIGKILL to ensure
  # child git/node processes are forcefully terminated.
  # OPS-P3-4: Exit with 142 (SIGALRM=14 + 128) to avoid collision with natural
  # exit code 124. Callers check both 124 (GNU timeout) and 142 (perl fallback).
  # SH-P1-2: Use process groups to kill grandchildren (git, npm, node) on timeout.
  # setpgrp(0,0) in the child creates a new process group. Negative PID in kill()
  # sends the signal to the entire process group, preventing zombie grandchildren.
  perl -e '
    use POSIX ":sys_wait_h";
    my $timeout = shift;
    my $pid = fork();
    if ($pid == 0) { setpgrp(0,0); exec @ARGV; exit(127); }
    eval {
      local $SIG{ALRM} = sub { die "alarm\n" };
      alarm $timeout;
      waitpid($pid, 0);
      alarm 0;
    };
    if ($@ eq "alarm\n") {
      kill "TERM", -$pid;
      # Wait up to 30s for graceful shutdown, then SIGKILL the process group
      for (1..30) { last if waitpid($pid, WNOHANG) > 0; sleep 1; }
      if (waitpid($pid, WNOHANG) == 0) { kill "KILL", -$pid; waitpid($pid, 0); }
      exit 142;
    }
    exit ($? >> 8);
  ' "$timeout_secs" "$@" 2>/dev/null
  local _perl_rc=$?
  # Normalize exit code 142 to 124 for consistent timeout detection across platforms
  [ "$_perl_rc" -eq 142 ] && return 124
  return $_perl_rc
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
    claude|codex|gemini|echo) echo "$SKYNET_SCRIPTS_DIR/agents/${name}.sh" ;;
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

  # Safety: validate prefix is alphanumeric+underscore only (it's always a hardcoded
  # internal value like "_claude", but defense-in-depth prevents injection if callers change)
  case "$prefix" in
    *[!a-zA-Z0-9_]*) log "ERROR: Invalid plugin prefix '$prefix'"; return 1 ;;
  esac

  if [ ! -f "$plugin_path" ]; then
    eval "${prefix}_agent_check() { return 1; }"
    eval "${prefix}_agent_run() { return 1; }"
    return
  fi

  # Validate plugin syntax before sourcing (catches parse errors safely)
  if ! bash -n "$plugin_path" 2>/dev/null; then
    log "ERROR: Agent plugin has syntax errors: $plugin_path"
    eval "${prefix}_agent_check() { return 1; }"
    eval "${prefix}_agent_run() { return 1; }"
    return
  fi

  # Source the plugin (defines agent_run + agent_check)
  # shellcheck source=/dev/null
  source "$plugin_path"

  # Default agent_check if plugin doesn't define one
  if ! declare -f agent_check >/dev/null 2>&1; then
    agent_check() { return 0; }
  fi

  # Rename functions under prefixed names. sed "1s/..." only modifies the declaration
  # line (always "agent_check ()"), not the function body, so internal string matches
  # are safe. eval is required because bash 3.2 lacks nameref for dynamic function names.
  # Prefix values are hardcoded constants ("_claude", "_codex", "_gemini") validated above.
  eval "$(declare -f agent_check | sed "1s/agent_check/${prefix}_agent_check/")"
  eval "$(declare -f agent_run | sed "1s/agent_run/${prefix}_agent_run/")"

  # Clean up generic names to avoid collisions with next plugin
  unset -f agent_check agent_run 2>/dev/null || true
}

# --- Set up run_agent() based on SKYNET_AGENT_PLUGIN ---

_plugin_resolved="$(_resolve_plugin_path "$SKYNET_AGENT_PLUGIN")"

if [ "$_plugin_resolved" = "auto" ]; then
  # Auto mode: try Claude first, fall back to Codex, then Gemini
  _load_plugin_as "_claude" "$SKYNET_SCRIPTS_DIR/agents/claude.sh"
  _load_plugin_as "_codex" "$SKYNET_SCRIPTS_DIR/agents/codex.sh"
  _load_plugin_as "_gemini" "$SKYNET_SCRIPTS_DIR/agents/gemini.sh"

  # Public API: run_agent "prompt" "log_file"
  # Returns the exit code of whichever agent ran.
  # Log agent usage to metrics file (auto-mode only)
  _log_agent_metric() {
    local agent_name="$1"
    local fallback_from="${2:-}"
    local _ts
    _ts=$(date '+%Y-%m-%d %H:%M:%S')
    if [ -n "$fallback_from" ]; then
      echo "$_ts agent=$agent_name fallback_from=$fallback_from task=${_CURRENT_TASK_TITLE:-unknown}" >> "$DEV_DIR/agent-metrics.log"
    else
      echo "$_ts agent=$agent_name task=${_CURRENT_TASK_TITLE:-unknown}" >> "$DEV_DIR/agent-metrics.log"
    fi
  }

  run_agent() {
    local prompt="$1"
    local log_file="${2:-/dev/null}"

    # Try Claude first
    if _claude_agent_check; then
      _claude_agent_run "$prompt" "$log_file"
      local exit_code=$?
      if [ "$exit_code" -eq 0 ]; then
        _log_agent_metric "claude"
        return 0
      fi
      # Claude failed — try Codex as fallback
      if _codex_agent_check; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] Claude failed (exit $exit_code) — falling back to Codex CLI" >> "$log_file"
        tg "🔄 *$SKYNET_PROJECT_NAME_UPPER*: Claude failed — switching to Codex" 2>/dev/null || true
        _codex_agent_run "$prompt" "$log_file"
        local codex_rc=$?
        if [ "$codex_rc" -eq 0 ]; then
          _log_agent_metric "codex" "claude"
        fi
        return $codex_rc
      fi
      # Codex unavailable — try Gemini
      if _gemini_agent_check; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] Claude failed (exit $exit_code), Codex unavailable — falling back to Gemini CLI" >> "$log_file"
        tg "🔄 *$SKYNET_PROJECT_NAME_UPPER*: Claude failed, Codex down — switching to Gemini" 2>/dev/null || true
        _gemini_agent_run "$prompt" "$log_file"
        local gemini_rc=$?
        if [ "$gemini_rc" -eq 0 ]; then
          _log_agent_metric "gemini" "claude"
        fi
        return $gemini_rc
      fi
      return $exit_code
    fi

    # Claude unavailable — try Codex
    if _codex_agent_check; then
      echo "[$(date '+%Y-%m-%d %H:%M:%S')] Claude unavailable — falling back to Codex CLI" >> "$log_file"
      tg "🔄 *$SKYNET_PROJECT_NAME_UPPER*: Claude down — switching to Codex" 2>/dev/null || true
      _codex_agent_run "$prompt" "$log_file"
      local codex_rc=$?
      if [ "$codex_rc" -eq 0 ]; then
        _log_agent_metric "codex" "claude"
      fi
      return $codex_rc
    fi

    # Codex unavailable — try Gemini
    if _gemini_agent_check; then
      echo "[$(date '+%Y-%m-%d %H:%M:%S')] Claude + Codex unavailable — falling back to Gemini CLI" >> "$log_file"
      tg "🔄 *$SKYNET_PROJECT_NAME_UPPER*: Claude + Codex down — switching to Gemini" 2>/dev/null || true
      _gemini_agent_run "$prompt" "$log_file"
      local gemini_rc=$?
      if [ "$gemini_rc" -eq 0 ]; then
        _log_agent_metric "gemini" "claude+codex"
      fi
      return $gemini_rc
    fi

    echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: No AI agent available (Claude, Codex, Gemini all unavailable)" >> "$log_file"
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
  if ! declare -f agent_check >/dev/null 2>&1; then
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
