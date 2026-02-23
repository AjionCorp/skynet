#!/usr/bin/env bash
# gemini.sh — Google Gemini CLI agent plugin for Skynet
#
# Standard agent plugin interface:
#   agent_check              — returns 0 if agent is available, 1 if not
#   agent_run "prompt" "log" — runs the agent, returns exit code
#
# Expects these env vars (set by _agent.sh / _config.sh):
#   SKYNET_GEMINI_BIN, SKYNET_GEMINI_FLAGS, SKYNET_GEMINI_MODEL,
#   SKYNET_GEMINI_AUTH_FAIL_FLAG

agent_check() {
  # Is the binary installed?
  if ! command -v "$SKYNET_GEMINI_BIN" >/dev/null 2>&1; then
    return 1
  fi
  # Check auth fail flag (set by check_gemini_auth in auth-check.sh)
  if [ -f "${SKYNET_GEMINI_AUTH_FAIL_FLAG:-}" ]; then
    return 1
  fi
  # Check auth: GEMINI_API_KEY or GOOGLE_API_KEY env var
  if [ -n "${GEMINI_API_KEY:-}" ] || [ -n "${GOOGLE_API_KEY:-}" ]; then
    return 0
  fi
  # Check for Google ADC (Application Default Credentials)
  local adc_path="${GOOGLE_APPLICATION_CREDENTIALS:-$HOME/.config/gcloud/application_default_credentials.json}"
  if [ -f "$adc_path" ] && [ -s "$adc_path" ]; then
    return 0
  fi
  # No auth found
  return 1
}

agent_run() {
  local prompt="$1"
  local log_file="${2:-/dev/null}"
  local model_flag=""
  if [ -n "${SKYNET_GEMINI_MODEL:-}" ]; then
    model_flag="-m $SKYNET_GEMINI_MODEL"
  fi
  # Pipe prompt via stdin to avoid ARG_MAX limit (~1MB on macOS).
  # printf is a shell builtin — not subject to ARG_MAX.
  # shellcheck disable=SC2086
  printf '%s\n' "$prompt" | _agent_exec $SKYNET_GEMINI_BIN $SKYNET_GEMINI_FLAGS $model_flag >> "$log_file" 2>&1
}
