#!/usr/bin/env bash
# notify/telegram.sh — Telegram notification channel plugin
# Sourced by _notify.sh. Implements notify_telegram().

# Send a Telegram message. No-op if not configured.
notify_telegram() {
  local msg="$1"
  [ "${SKYNET_TG_ENABLED:-false}" = "true" ] || return 0
  [ -n "${SKYNET_TG_BOT_TOKEN:-}" ] || return 0
  [ -n "${SKYNET_TG_CHAT_ID:-}" ] || return 0

  curl -sf -X POST \
    "https://api.telegram.org/bot${SKYNET_TG_BOT_TOKEN}/sendMessage" \
    -d chat_id="$SKYNET_TG_CHAT_ID" \
    -d text="$msg" \
    -d parse_mode="Markdown" > /dev/null 2>&1 || true
}
