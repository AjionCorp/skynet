#!/usr/bin/env bash
# claude.sh — Claude Code agent plugin for Skynet
#
# Standard agent plugin interface:
#   agent_check              — returns 0 if agent is available, 1 if not
#   agent_run "prompt" "log" — runs the agent, returns exit code
#
# Expects these env vars (set by _config.sh):
#   SKYNET_CLAUDE_BIN, SKYNET_CLAUDE_FLAGS,
#   SKYNET_AUTH_TOKEN_CACHE, SKYNET_AUTH_FAIL_FLAG

agent_check() {
  # Is the binary installed?
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

agent_run() {
  local prompt="$1"
  local log_file="${2:-/dev/null}"
  unset CLAUDECODE 2>/dev/null || true
  # shellcheck disable=SC2086
  $SKYNET_CLAUDE_BIN $SKYNET_CLAUDE_FLAGS "$prompt" >> "$log_file" 2>&1
}
