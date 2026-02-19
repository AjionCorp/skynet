#!/usr/bin/env bash
# clean-logs.sh — Trim log files to only keep lines from the last 24 hours.
# Called by watchdog.sh on each run. Uses a simple approach:
# find the first timestamped line within the cutoff window, keep everything from there.
# Log timestamps are formatted as: [YYYY-MM-DD HH:MM:SS]

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_config.sh"

CUTOFF=$(date_24h_ago)

for logfile in "$SCRIPTS_DIR"/*.log; do
  [ -f "$logfile" ] || continue

  # Skip tiny files (< 50KB)
  size=$(file_size "$logfile")
  [ "$size" -lt 51200 ] && continue

  # Find the line number of the first timestamp >= cutoff
  first_line=""
  while IFS= read -r match; do
    line_no="${match%%:*}"
    ts=$(echo "$match" | sed -n 's/.*\[\([0-9]\{4\}-[0-9]\{2\}-[0-9]\{2\} [0-9]\{2\}:[0-9]\{2\}:[0-9]\{2\}\)\].*/\1/p')
    if [ -n "$ts" ] && [ "$ts" \> "$CUTOFF" -o "$ts" = "$CUTOFF" ]; then
      first_line="$line_no"
      break
    fi
  done < <(grep -n '^\[' "$logfile" 2>/dev/null)

  if [ -n "$first_line" ] && [ "$first_line" -gt 10 ]; then
    tail -n +"$first_line" "$logfile" > "$logfile.tmp" && mv "$logfile.tmp" "$logfile"
  fi
done
