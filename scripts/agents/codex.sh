#!/usr/bin/env bash
# codex.sh — OpenAI Codex CLI agent plugin for Skynet
#
# Standard agent plugin interface:
#   agent_check              — returns 0 if agent is available, 1 if not
#   agent_run "prompt" "log" — runs the agent, returns exit code
#
# Expects these env vars (set by _agent.sh):
#   SKYNET_CODEX_BIN, SKYNET_CODEX_FLAGS

agent_check() {
  command -v "$SKYNET_CODEX_BIN" &>/dev/null
}

agent_run() {
  local prompt="$1"
  local log_file="${2:-/dev/null}"
  # shellcheck disable=SC2086
  $SKYNET_CODEX_BIN $SKYNET_CODEX_FLAGS "$prompt" >> "$log_file" 2>&1
}
