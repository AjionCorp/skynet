#!/usr/bin/env bash
# codex.sh — OpenAI Codex CLI agent plugin for Skynet
#
# Standard agent plugin interface:
#   agent_check              — returns 0 if agent is available, 1 if not
#   agent_run "prompt" "log" — runs the agent, returns exit code
#
# Expects these env vars (set by _agent.sh / _config.sh):
#   SKYNET_CODEX_BIN, SKYNET_CODEX_FLAGS, SKYNET_CODEX_MODEL, SKYNET_CODEX_SUBCOMMAND,
#   SKYNET_CODEX_AUTH_FILE, SKYNET_CODEX_AUTH_FAIL_FLAG

agent_check() {
  # Is the binary installed?
  if ! command -v "$SKYNET_CODEX_BIN" >/dev/null 2>&1; then
    return 1
  fi
  # Check auth fail flag (set by check_codex_auth in auth-check.sh)
  if [ -f "${SKYNET_CODEX_AUTH_FAIL_FLAG:-}" ]; then
    return 1
  fi
  # Check auth: either OPENAI_API_KEY is set or auth.json exists
  if [ -n "${OPENAI_API_KEY:-}" ]; then
    return 0
  fi
  local auth_file="${SKYNET_CODEX_AUTH_FILE:-$HOME/.codex/auth.json}"
  if [ -f "$auth_file" ] && [ -s "$auth_file" ]; then
    return 0
  fi
  # No auth found
  return 1
}

agent_run() {
  local prompt="$1"
  local log_file="${2:-/dev/null}"
  local model_flag=""
  if [ -n "${SKYNET_CODEX_MODEL:-}" ]; then
    model_flag="--model $SKYNET_CODEX_MODEL"
  fi
  local subcommand="${SKYNET_CODEX_SUBCOMMAND:-exec}"
  # shellcheck disable=SC2086
  _agent_exec $SKYNET_CODEX_BIN $subcommand $SKYNET_CODEX_FLAGS $model_flag "$prompt" >> "$log_file" 2>&1
}
