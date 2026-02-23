#!/usr/bin/env bash
# notify/discord.sh — Discord notification channel plugin
# Sourced by _notify.sh. Implements notify_discord().

# Send a Discord message via webhook. No-op if not configured.
notify_discord() {
  local msg="$1"
  [ -n "${SKYNET_DISCORD_WEBHOOK_URL:-}" ] || return 0

  # Prefer python3 for JSON escaping; fall back to shell-based escaping
  local json_msg
  if command -v python3 &>/dev/null; then
    json_msg=$(printf '%s' "$msg" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')
  else
    json_msg="\"$(printf '%s' "$msg" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n' ' ')\""
  fi

  if ! curl -sf -X POST "$SKYNET_DISCORD_WEBHOOK_URL" \
    -H "Content-Type: application/json" \
    -d "{\"content\": $json_msg}" \
    > /dev/null 2>&1; then
    # Log failure with redacted webhook URL — never expose raw URL
    if declare -f _redact_for_log >/dev/null 2>&1; then
      log "Discord notify failed (webhook=$(_redact_for_log "$SKYNET_DISCORD_WEBHOOK_URL"))"
    fi
  fi
}
