#!/usr/bin/env bash
# auth-check.sh — Shared Claude Code auth resilience for pipeline scripts
#
# Source this from any pipeline script AFTER sourcing _config.sh
#   source "$SCRIPTS_DIR/auth-check.sh"
#   check_claude_auth || exit 1
#
# What it does:
# - On first failure: sends Telegram alert, adds blocker to blockers.md
# - On repeat failures: throttles alerts to once per hour (not every 3 min)
# - On recovery: sends Telegram "restored" message, clears blocker

type log &>/dev/null || log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >&2; }

AUTH_NOTIFY_INTERVAL=3600  # seconds between repeat Telegram alerts

check_claude_auth() {
  unset CLAUDECODE 2>/dev/null || true

  # Read token from cache file (written by auth-refresh LaunchAgent)
  local _auth_ok=false
  local _access_token=""
  [ -f "$SKYNET_AUTH_TOKEN_CACHE" ] && _access_token=$(cat "$SKYNET_AUTH_TOKEN_CACHE" 2>/dev/null)
  [ -n "$_access_token" ] \
    && curl -sf -o /dev/null --max-time 10 \
         https://api.anthropic.com/api/oauth/claude_cli/roles \
         -H "Authorization: Bearer $_access_token" \
         -H "Content-Type: application/json" \
    && _auth_ok=true

  if $_auth_ok; then
    # Auth works — clear any previous failure state
    if [ -f "$SKYNET_AUTH_FAIL_FLAG" ]; then
      rm -f "$SKYNET_AUTH_FAIL_FLAG"
      log "Claude Code auth restored. Pipeline resuming."
      tg "✅ *$SKYNET_PROJECT_NAME_UPPER AUTH RESTORED* — Claude Code authenticated again. Pipeline resuming."
      # Remove auth blocker from blockers.md
      if [ -f "$BLOCKERS" ]; then
        grep -v "Claude Code authentication expired" "$BLOCKERS" > "$BLOCKERS.tmp" || true
        mv "$BLOCKERS.tmp" "$BLOCKERS"
      fi
    fi
    return 0
  fi

  # Auth failed — throttle notifications
  local now
  now=$(date +%s)
  local should_notify=true

  if [ -f "$SKYNET_AUTH_FAIL_FLAG" ]; then
    local last_notify
    last_notify=$(cat "$SKYNET_AUTH_FAIL_FLAG")
    local elapsed=$((now - last_notify))
    if [ "$elapsed" -lt "$AUTH_NOTIFY_INTERVAL" ]; then
      should_notify=false
    fi
  fi

  if $should_notify; then
    echo "$now" > "$SKYNET_AUTH_FAIL_FLAG"
    tg "🔴 *$SKYNET_PROJECT_NAME_UPPER AUTH DOWN* — Claude Code not authenticated. All pipeline jobs paused. Run: claude then /login"
    log "Claude Code not authenticated. Telegram alert sent."
    # Add to blockers if not already there
    if ! grep -q "Claude Code authentication expired" "$BLOCKERS" 2>/dev/null; then
      echo "- **$(date '+%Y-%m-%d %H:%M')**: Claude Code authentication expired. Run \`claude\` and \`/login\` to restore. All pipeline jobs are paused." >> "$BLOCKERS"
    fi
  else
    log "Claude Code not authenticated. (alert throttled, next in $((AUTH_NOTIFY_INTERVAL - elapsed))s)"
  fi

  return 1
}
