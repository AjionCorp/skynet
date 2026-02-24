#!/usr/bin/env bash
# clean-logs.sh — Trim log files to only keep lines from the last 24 hours.
# Called by watchdog.sh on each run. Uses a simple approach:
# find the first timestamped line within the cutoff window, keep everything from there.
# Log timestamps are formatted as: [YYYY-MM-DD HH:MM:SS]

# OPS-P2-1: Skip DB re-initialization when already initialized by parent (watchdog)
: "${_SKYNET_DB_INITIALIZED:=0}"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_config.sh"

CUTOFF=$(date_24h_ago)

for logfile in "$SCRIPTS_DIR"/*.log; do
  [ -f "$logfile" ] || continue

  # Skip tiny files (< 50KB)
  size=$(file_size "$logfile")
  [ "$size" -lt 51200 ] && continue

  # Find the line number of the first timestamp >= cutoff.
  # The `|| true` prevents grep's exit-code-1 (no matches) from propagating
  # through the process substitution when set -e is active.
  first_line=""
  while IFS= read -r match; do
    line_no="${match%%:*}"
    ts=$(echo "$match" | sed -n 's/.*\[\([0-9]\{4\}-[0-9]\{2\}-[0-9]\{2\} [0-9]\{2\}:[0-9]\{2\}:[0-9]\{2\}\)\].*/\1/p')
    # NOTE: String comparison of ISO timestamps works correctly in all locales
    # because YYYY-MM-DD HH:MM:SS is lexicographically sortable.
    if [ -n "$ts" ] && { [ "$ts" \> "$CUTOFF" ] || [ "$ts" = "$CUTOFF" ]; }; then
      first_line="$line_no"
      break
    fi
  done < <(grep -n '^\[' "$logfile" 2>/dev/null || true)

  if [ -n "$first_line" ] && [ "$first_line" -gt 10 ]; then
    tail -n +"$first_line" "$logfile" > "$logfile.tmp" && mv "$logfile.tmp" "$logfile"
  fi
done

# Rotate events.log if it exceeds SKYNET_MAX_EVENTS_LOG_KB (default 1024 KB)
_events_log="$DEV_DIR/events.log"
if [ -f "$_events_log" ]; then
  _events_max_bytes=$(( ${SKYNET_MAX_EVENTS_LOG_KB:-1024} * 1024 ))
  _events_size=$(file_size "$_events_log")
  if [ "$_events_size" -gt "$_events_max_bytes" ]; then
    rm -f "${_events_log}.2"
    [ -f "${_events_log}.1" ] && mv "${_events_log}.1" "${_events_log}.2"
    mv "$_events_log" "${_events_log}.1"
  fi
fi

# Clean up rotated log backups older than 24h
find "$SCRIPTS_DIR" -maxdepth 1 -name "*.log.[12]" -mtime +1 -exec rm -f {} + 2>/dev/null || true
find "$DEV_DIR" -maxdepth 1 -name "*.log.[12]" -mtime +1 -exec rm -f {} + 2>/dev/null || true
