#!/usr/bin/env bash
# start-dev.sh — Start dev server with log capture
# Usage: bash scripts/start-dev.sh [worker_id]
# When worker_id is provided, logs go to scripts/next-dev-w<id>.log
# When omitted, logs go to scripts/next-dev.log (backward compatible)
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_config.sh"

if [ -n "${1:-}" ]; then
  LOG="$SCRIPTS_DIR/next-dev-w${1}.log"
  PIDFILE="$SCRIPTS_DIR/next-dev-w${1}.pid"
else
  LOG="$SCRIPTS_DIR/next-dev.log"
  PIDFILE="$SCRIPTS_DIR/next-dev.pid"
fi

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
# shellcheck disable=SC2086
nohup $SKYNET_DEV_SERVER_CMD >> "$LOG" 2>&1 &
echo $! > "$PIDFILE"

echo "Dev server started (PID $!). Logs: $LOG"
echo "Stop with: kill \$(cat $PIDFILE)"
