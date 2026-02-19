#!/usr/bin/env bash
# start-dev.sh — Start dev server with log capture
# Usage: bash scripts/start-dev.sh
# Logs go to scripts/next-dev.log (last 5000 lines kept)
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_config.sh"

LOG="$SCRIPTS_DIR/next-dev.log"
PIDFILE="$SCRIPTS_DIR/next-dev.pid"

cd "$PROJECT_DIR"

# Check if already running
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "Dev server already running (PID $(cat "$PIDFILE"))."
  exit 0
fi

# Truncate log if too large (keep last 5000 lines)
if [ -f "$LOG" ] && [ "$(wc -l < "$LOG")" -gt 5000 ]; then
  tail -5000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting dev server..." >> "$LOG"

# Start server in background with log capture
nohup $SKYNET_DEV_SERVER_CMD >> "$LOG" 2>&1 &
echo $! > "$PIDFILE"

echo "Dev server started (PID $!). Logs: $LOG"
echo "Stop with: kill \$(cat $PIDFILE)"
