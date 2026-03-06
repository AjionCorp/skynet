#!/usr/bin/env bash
# start-dev.sh — Start dev server with log capture
# Usage: bash scripts/start-dev.sh [worker_id]
# When worker_id is provided, logs go to scripts/next-dev-w<id>.log
# When omitted, logs go to scripts/next-dev.log (backward compatible)
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_config.sh"

if [ -n "${1:-}" ]; then
  LOG="$LOG_DIR/next-dev-w${1}.log"
  PIDFILE="$LOG_DIR/next-dev-w${1}.pid"
else
  LOG="$LOG_DIR/next-dev.log"
  PIDFILE="$LOG_DIR/next-dev.pid"
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

# Guard against empty or unset command
if [ -z "${SKYNET_DEV_SERVER_CMD:-}" ]; then
  echo "ERROR: SKYNET_DEV_SERVER_CMD is not set. Cannot start dev server." >&2
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: SKYNET_DEV_SERVER_CMD is empty — aborting" >> "$LOG"
  exit 1
fi

# Validate dev server command against disallowed characters (defense-in-depth)
# SH-P2-7: Also reject ".." to match _config.sh's validation pattern
case "$SKYNET_DEV_SERVER_CMD" in *";"*|*"|"*|*'$('*|*'`'*|*".."*) echo "ERROR: SKYNET_DEV_SERVER_CMD contains unsafe characters" >&2; exit 1 ;; esac

# Start server in background with log capture
# shellcheck disable=SC2086
nohup ${SKYNET_DEV_SERVER_CMD} >> "$LOG" 2>&1 &
echo $! > "$PIDFILE"
_SERVER_PID=$!

echo "Dev server started (PID $_SERVER_PID). Logs: $LOG"
echo "Stop with: kill \$(cat $PIDFILE)"

# OPS-P2-6: Poll for server health after launch (up to 15 seconds)
# Workers launch per-port dev servers, so probe the explicit PORT when set
# instead of the shared default admin URL.
_health_base="${SKYNET_DEV_SERVER_URL:-http://localhost:3100}"
[ -n "${PORT:-}" ] && _health_base="http://localhost:${PORT}"
_health_url="${_health_base}/api/admin/pipeline/status"
_ready=false
for _i in $(seq 1 15); do
  if ! kill -0 "$_SERVER_PID" 2>/dev/null; then
    echo "ERROR: Dev server process died during startup. Check logs: $LOG" >&2
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: Server process died during startup (PID $_SERVER_PID)" >> "$LOG"
    rm -f "$PIDFILE"
    exit 1
  fi
  if curl -sf "$_health_url" > /dev/null 2>&1; then
    _ready=true
    break
  fi
  sleep 1
done
if ! $_ready; then
  echo "WARNING: Dev server started but did not respond within 15s. Check logs: $LOG" >&2
fi
