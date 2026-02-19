#!/usr/bin/env bash
# _notify.sh — Notification helpers (pluggable channels)
# Sourced by _config.sh. Dispatches to all enabled channels.
#
# Channel plugins live in scripts/notify/*.sh. Each defines a
# notify_<channel>() function. Set SKYNET_NOTIFY_CHANNELS in
# skynet.config.sh to a comma-separated list of enabled channels
# (e.g. "telegram", "telegram,slack,discord").

# Default: telegram only (backward compatible)
export SKYNET_NOTIFY_CHANNELS="${SKYNET_NOTIFY_CHANNELS:-telegram}"

# Source all channel plugins
for _notify_plugin in "$SKYNET_SCRIPTS_DIR"/notify/*.sh; do
  [ -f "$_notify_plugin" ] || continue
  # shellcheck source=/dev/null
  source "$_notify_plugin"
done
unset _notify_plugin

# Dispatch a message to all enabled notification channels.
# Each channel's notify_<name>() is called; failures are silenced.
_notify_all() {
  local msg="$1"
  local _old_ifs="$IFS"
  IFS=','
  for _channel in $SKYNET_NOTIFY_CHANNELS; do
    _channel=$(echo "$_channel" | sed 's/^ *//;s/ *$//')
    [ -z "$_channel" ] && continue
    local _fn="notify_${_channel}"
    if declare -f "$_fn" > /dev/null 2>&1; then
      "$_fn" "$msg" || true
    fi
  done
  IFS="$_old_ifs"
}

# Public API: tg "message"
# Kept as tg() for backward compatibility — all existing callers work unchanged.
# Dispatches to every enabled channel in SKYNET_NOTIFY_CHANNELS.
tg() {
  _notify_all "$1"
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
