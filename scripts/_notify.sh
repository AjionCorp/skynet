#!/usr/bin/env bash
# _notify.sh — Notification helpers (Telegram)
# Sourced by _config.sh. Only sends if configured.

# Send a Telegram message. No-op if not configured.
tg() {
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

# Send a throttled notification (max once per interval)
# Usage: tg_throttled "flag_file" interval_secs "message"
tg_throttled() {
  local flag_file="$1"
  local interval="${2:-3600}"
  local msg="$3"

  local now
  now=$(date +%s)

  if [ -f "$flag_file" ]; then
    local last
    last=$(cat "$flag_file" 2>/dev/null || echo 0)
    local diff=$((now - last))
    [ "$diff" -lt "$interval" ] && return 0
  fi

  echo "$now" > "$flag_file"
  tg "$msg"
}
