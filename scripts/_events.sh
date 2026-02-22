#!/usr/bin/env bash
# _events.sh — Structured event logging for the pipeline
# Sourced by _config.sh. Provides emit_event() to all scripts.
#
# Events are appended to $DEV_DIR/events.log in pipe-delimited format:
#   epoch|event_name|description
# This mirrors the fixer-stats.log pattern for structured log data.

# Emit a named pipeline event with optional description.
# Usage: emit_event "event_name" "description"
emit_event() {
  local event="$1"
  local description="${2:-}"

  # Write to SQLite (primary)
  local _wid="${WORKER_ID:-${FIXER_ID:-}}"
  db_add_event "$event" "$description" "$_wid" 2>/dev/null || true

  # Also append to flat file for backward compat during transition
  local events_log="$DEV_DIR/events.log"
  local max_kb="${SKYNET_MAX_EVENTS_LOG_KB:-1024}"
  if [ -f "$events_log" ]; then
    local sz
    sz=$(wc -c < "$events_log" 2>/dev/null || echo 0)
    if [ "$sz" -gt $((max_kb * 1024)) ]; then
      mv "$events_log" "${events_log}.1"
    fi
  fi
  echo "$(date +%s)|${event}|${description}" >> "$events_log"
}
