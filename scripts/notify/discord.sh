#!/usr/bin/env bash
# notify/discord.sh — Discord notification channel plugin
# Sourced by _notify.sh. Implements notify_discord().

# Send a Discord message via webhook. No-op if not configured.
notify_discord() {
  local msg="$1"
  [ -n "${SKYNET_DISCORD_WEBHOOK_URL:-}" ] || return 0

  curl -sf -X POST "$SKYNET_DISCORD_WEBHOOK_URL" \
    -H "Content-Type: application/json" \
    -d "{\"content\": $(printf '%s' "$msg" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')}" \
    > /dev/null 2>&1 || true
}
