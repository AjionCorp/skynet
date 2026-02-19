#!/usr/bin/env bash
# watchdog.sh — Lightweight dispatcher that prevents idle time
# Runs every 3 min via crontab. Checks if workers are idle with work waiting, kicks them off.
# Does NOT invoke Claude itself — just launches the worker scripts.
# Auth-aware: skips Claude-dependent workers when auth is expired.
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_config.sh"

LOG="$SCRIPTS_DIR/watchdog.log"
AUTH_NOTIFY_INTERVAL=3600

cd "$PROJECT_DIR"

# Trim logs to last 24h on each watchdog run
bash "$SCRIPTS_DIR/clean-logs.sh" 2>/dev/null || true

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }

is_running() {
  local lockfile="$1"
  [ -f "$lockfile" ] && kill -0 "$(cat "$lockfile")" 2>/dev/null
}

# --- Auth pre-check: don't kick off Claude workers if auth is down ---
# Read token from cache file (written by auth-refresh LaunchAgent)
claude_auth_ok=false
_access_token=""
[ -f "$SKYNET_AUTH_TOKEN_CACHE" ] && _access_token=$(cat "$SKYNET_AUTH_TOKEN_CACHE" 2>/dev/null)
if [ -n "$_access_token" ] && curl -sf -o /dev/null --max-time 10 \
     https://api.anthropic.com/api/oauth/claude_cli/roles \
     -H "Authorization: Bearer $_access_token" \
     -H "Content-Type: application/json"; then
  claude_auth_ok=true
  # Clear failure flag if it was set
  if [ -f "$SKYNET_AUTH_FAIL_FLAG" ]; then
    rm -f "$SKYNET_AUTH_FAIL_FLAG"
    log "Claude auth restored!"
    tg "✅ *${SKYNET_PROJECT_NAME^^} AUTH RESTORED* — Pipeline resuming."
    # Remove auth blocker
    if [ -f "$BLOCKERS" ]; then
      grep -v "Claude Code authentication expired" "$BLOCKERS" > "$BLOCKERS.tmp" 2>/dev/null || true
      mv "$BLOCKERS.tmp" "$BLOCKERS"
    fi
  fi
else
  # Auth failed — throttle Telegram alerts
  now_epoch=$(date +%s)
  should_notify=true
  if [ -f "$SKYNET_AUTH_FAIL_FLAG" ]; then
    last_notify=$(cat "$SKYNET_AUTH_FAIL_FLAG")
    elapsed=$((now_epoch - last_notify))
    [ "$elapsed" -lt "$AUTH_NOTIFY_INTERVAL" ] && should_notify=false
  fi
  if $should_notify; then
    echo "$now_epoch" > "$SKYNET_AUTH_FAIL_FLAG"
    log "Claude auth FAILED. Skipping Claude workers. Telegram alert sent."
    tg "🔴 *${SKYNET_PROJECT_NAME^^} AUTH DOWN* — Claude not authenticated. Pipeline paused. Run: claude then /login"
    if ! grep -q "Claude Code authentication expired" "$BLOCKERS" 2>/dev/null; then
      echo "- **$(date '+%Y-%m-%d %H:%M')**: Claude Code authentication expired. Run \`claude\` and \`/login\` to restore." >> "$BLOCKERS"
    fi
  else
    log "Claude auth still down. Skipping Claude workers. (alert throttled)"
  fi
fi

# Count backlog tasks (grep -c exits 1 on no match, so use || true and default)
backlog_count=$(grep -c '^\- \[ \]' "$BACKLOG" 2>/dev/null || true)
backlog_count=${backlog_count:-0}
backlog_count=$((backlog_count + 0))

# Count pending failed tasks
failed_pending=$(grep -c '| pending |' "$FAILED" 2>/dev/null || true)
failed_pending=${failed_pending:-0}
failed_pending=$((failed_pending + 0))

# Check worker states
w1_running=false
w2_running=false
fixer_running=false
driver_running=false

is_running "${SKYNET_LOCK_PREFIX}-dev-worker-1.lock" && w1_running=true
is_running "${SKYNET_LOCK_PREFIX}-dev-worker-2.lock" && w2_running=true
is_running "${SKYNET_LOCK_PREFIX}-task-fixer.lock" && fixer_running=true
is_running "${SKYNET_LOCK_PREFIX}-project-driver.lock" && driver_running=true

# --- Only kick Claude-dependent workers if auth is OK ---
if $claude_auth_ok; then
  # Rule 1a: Backlog has tasks + worker 1 idle → kick off worker 1
  if [ "$backlog_count" -gt 0 ] && ! $w1_running; then
    log "Backlog has $backlog_count tasks, worker 1 idle. Kicking off."
    tg "👁 *WATCHDOG*: Kicking off dev-worker 1 ($backlog_count tasks waiting)"
    nohup bash "$SCRIPTS_DIR/dev-worker.sh" 1 >> "$SCRIPTS_DIR/dev-worker-1.log" 2>&1 &
  fi

  # Rule 1b: Backlog has 2+ tasks + worker 2 idle → kick off worker 2
  if [ "$backlog_count" -ge 2 ] && ! $w2_running; then
    log "Backlog has $backlog_count tasks (>=2), worker 2 idle. Kicking off."
    tg "👁 *WATCHDOG*: Kicking off dev-worker 2 ($backlog_count tasks waiting)"
    nohup bash "$SCRIPTS_DIR/dev-worker.sh" 2 >> "$SCRIPTS_DIR/dev-worker-2.log" 2>&1 &
  fi

  # Rule 2: Failed tasks pending + fixer idle → kick off task-fixer
  if [ "$failed_pending" -gt 0 ] && ! $fixer_running; then
    log "Failed tasks pending ($failed_pending), task-fixer idle. Kicking off."
    tg "👁 *WATCHDOG*: Kicking off task-fixer ($failed_pending failed tasks)"
    nohup bash "$SCRIPTS_DIR/task-fixer.sh" >> "$SCRIPTS_DIR/task-fixer.log" 2>&1 &
  fi

  # Rule 3: Always kick off project-driver if it's not already running
  if ! $driver_running; then
    log "Project-driver idle (backlog: $backlog_count). Kicking off."
    tg "👁 *WATCHDOG*: Kicking off project-driver (backlog: $backlog_count tasks)"
    nohup bash "$SCRIPTS_DIR/project-driver.sh" >> "$SCRIPTS_DIR/project-driver.log" 2>&1 &
  fi
fi
