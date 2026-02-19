#!/usr/bin/env bash
# _agent.sh — AI agent abstraction layer
# Tries Claude Code first, falls back to OpenAI Codex CLI if auth fails.
# Sourced by _config.sh — available to all scripts via run_agent().

# Codex CLI defaults (override in skynet.config.sh)
export SKYNET_CODEX_BIN="${SKYNET_CODEX_BIN:-codex}"
export SKYNET_CODEX_FLAGS="${SKYNET_CODEX_FLAGS:---full-auto}"
export SKYNET_AGENT_PREFERENCE="${SKYNET_AGENT_PREFERENCE:-auto}"  # claude | codex | auto

# Internal: check if Claude Code is available and authenticated
_check_claude_available() {
  # Quick check: is the binary installed?
  if ! command -v "$SKYNET_CLAUDE_BIN" &>/dev/null; then
    return 1
  fi
  # Check cached token if available
  if [ -f "$SKYNET_AUTH_TOKEN_CACHE" ]; then
    local token
    token=$(cat "$SKYNET_AUTH_TOKEN_CACHE" 2>/dev/null)
    if [ -n "$token" ]; then
      # Token exists — assume valid (auth-refresh keeps it current)
      return 0
    fi
  fi
  # Check auth fail flag
  if [ -f "$SKYNET_AUTH_FAIL_FLAG" ]; then
    return 1
  fi
  # No cache but no fail flag either — optimistically try
  return 0
}

# Internal: run Claude Code with the given prompt
_run_claude() {
  local prompt="$1"
  local log_file="${2:-/dev/null}"
  unset CLAUDECODE 2>/dev/null || true
  $SKYNET_CLAUDE_BIN $SKYNET_CLAUDE_FLAGS "$prompt" >> "$log_file" 2>&1
}

# Internal: run Codex CLI with the given prompt
_run_codex() {
  local prompt="$1"
  local log_file="${2:-/dev/null}"
  $SKYNET_CODEX_BIN $SKYNET_CODEX_FLAGS "$prompt" >> "$log_file" 2>&1
}

# Public API: run_agent "prompt" "log_file"
# Returns the exit code of whichever agent ran.
# Tries Claude first (unless preference says otherwise), falls back to Codex.
run_agent() {
  local prompt="$1"
  local log_file="${2:-/dev/null}"

  # Forced Codex mode
  if [ "$SKYNET_AGENT_PREFERENCE" = "codex" ]; then
    if command -v "$SKYNET_CODEX_BIN" &>/dev/null; then
      _run_codex "$prompt" "$log_file"
      return $?
    else
      echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: Codex CLI not found ($SKYNET_CODEX_BIN)" >> "$log_file"
      return 1
    fi
  fi

  # Claude-first mode (claude or auto)
  if _check_claude_available; then
    _run_claude "$prompt" "$log_file"
    local exit_code=$?
    if [ "$exit_code" -eq 0 ]; then
      return 0
    fi
    # Claude failed — if auto mode, try Codex as fallback
    if [ "$SKYNET_AGENT_PREFERENCE" = "auto" ] && command -v "$SKYNET_CODEX_BIN" &>/dev/null; then
      echo "[$(date '+%Y-%m-%d %H:%M:%S')] Claude failed (exit $exit_code) — falling back to Codex CLI" >> "$log_file"
      type tg &>/dev/null 2>&1 && tg "🔄 *${SKYNET_PROJECT_NAME^^}*: Claude failed — switching to Codex" 2>/dev/null || true
      _run_codex "$prompt" "$log_file"
      return $?
    fi
    return $exit_code
  fi

  # Claude unavailable — try Codex if in auto mode
  if [ "$SKYNET_AGENT_PREFERENCE" = "auto" ] && command -v "$SKYNET_CODEX_BIN" &>/dev/null; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Claude unavailable — falling back to Codex CLI" >> "$log_file"
    type tg &>/dev/null 2>&1 && tg "🔄 *${SKYNET_PROJECT_NAME^^}*: Claude down — switching to Codex" 2>/dev/null || true
    _run_codex "$prompt" "$log_file"
    return $?
  fi

  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: No AI agent available (Claude auth failed, Codex not installed)" >> "$log_file"
  return 1
}
