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
  local events_log="$DEV_DIR/events.log"
  echo "$(date +%s)|${event}|${description}" >> "$events_log"
}
