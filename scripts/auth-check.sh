#!/usr/bin/env bash
# auth-check.sh — Shared AI agent auth resilience for pipeline scripts
#
# Source this from any pipeline script AFTER sourcing _config.sh
#   source "$SCRIPTS_DIR/auth-check.sh"
#   check_claude_auth || exit 1
#   check_codex_auth   # non-fatal — just sets fail flag for fallback awareness
#
# What it does:
# - On first failure: sends Telegram alert, adds blocker to blockers.md
# - On repeat failures: throttles alerts to once per hour (not every 3 min)
# - On recovery: sends Telegram "restored" message, clears blocker

if ! declare -f log >/dev/null 2>&1; then
  log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >&2; }
fi

AUTH_NOTIFY_INTERVAL="${SKYNET_AUTH_NOTIFY_INTERVAL:-3600}"  # seconds between repeat Telegram alerts

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

  # Auth failed — try auto-refresh before giving up
  if [ -f "$SCRIPTS_DIR/auth-refresh.sh" ]; then
    log "Auth failed — triggering auth-refresh.sh to attempt token refresh..."
    if bash "$SCRIPTS_DIR/auth-refresh.sh" 2>>"${LOG:-/tmp/skynet-auth-refresh.err}"; then
      # Re-read refreshed token and retry
      _access_token=""
      [ -f "$SKYNET_AUTH_TOKEN_CACHE" ] && _access_token=$(cat "$SKYNET_AUTH_TOKEN_CACHE" 2>/dev/null)
      if [ -n "$_access_token" ] \
        && curl -sf -o /dev/null --max-time 10 \
             https://api.anthropic.com/api/oauth/claude_cli/roles \
             -H "Authorization: Bearer $_access_token" \
             -H "Content-Type: application/json"; then
        log "Auth restored after auto-refresh."
        rm -f "$SKYNET_AUTH_FAIL_FLAG"
        if [ -f "$BLOCKERS" ]; then
          grep -v "Claude Code authentication expired" "$BLOCKERS" > "$BLOCKERS.tmp" || true
          mv "$BLOCKERS.tmp" "$BLOCKERS"
        fi
        return 0
      fi
      log "Auth still failing after refresh attempt."
    else
      log "auth-refresh.sh failed (exit $?)."
    fi
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

CODEX_NOTIFY_INTERVAL="${SKYNET_CODEX_NOTIFY_INTERVAL:-3600}"  # seconds between repeat Telegram alerts
CODEX_REFRESH_BUFFER_SECS="${SKYNET_CODEX_REFRESH_BUFFER_SECS:-900}"

check_codex_auth() {
  # Check if codex binary is installed
  if ! command -v "${SKYNET_CODEX_BIN:-codex}" >/dev/null 2>&1; then
    # Not installed — not an error, just unavailable
    return 1
  fi

  # Check auth: OPENAI_API_KEY env var or ~/.codex/auth.json
  local _codex_auth_ok=false
  local _auth_file="${SKYNET_CODEX_AUTH_FILE:-$HOME/.codex/auth.json}"

  if [ -n "${OPENAI_API_KEY:-}" ]; then
    _codex_auth_ok=true
  elif [ -f "$_auth_file" ] && [ -s "$_auth_file" ]; then
    # Check token expiry (if available) and refresh if needed
    local parsed
    parsed=$(AUTH_FILE="$_auth_file" python3 - <<'PY'
import base64, json, os, time
p = os.environ.get('AUTH_FILE')
try:
    with open(p) as f:
        data = json.load(f)
except Exception:
    print("0")
    print("0")
    raise SystemExit

tokens = data.get('tokens', {})
refresh = tokens.get('refresh_token', '')
id_token = tokens.get('id_token') or tokens.get('access_token') or ''

def decode_claims(token):
    parts = token.split('.')
    if len(parts) < 2:
        return {}
    payload = parts[1]
    payload += '=' * (-len(payload) % 4)
    try:
        return json.loads(base64.urlsafe_b64decode(payload.encode()))
    except Exception:
        return {}

exp = 0
if id_token:
    claims = decode_claims(id_token)
    exp = claims.get('exp', 0) or 0

print(exp)
print(1 if refresh else 0)
PY
)
    local exp has_refresh
    {
      read -r exp
      read -r has_refresh
    } <<< "$parsed"

    local now remaining
    now=$(date +%s)
    remaining=$(( exp > 0 ? exp - now : 0 ))

    if [ "$exp" -gt 0 ] && [ "$remaining" -le "$CODEX_REFRESH_BUFFER_SECS" ]; then
      if [ "$has_refresh" -eq 1 ] && [ -f "$SCRIPTS_DIR/codex-auth-refresh.sh" ]; then
        log "Codex token expiring soon (${remaining}s). Attempting refresh..."
        if bash "$SCRIPTS_DIR/codex-auth-refresh.sh" 2>>"${LOG:-/tmp/skynet-codex-auth-refresh.err}"; then
          _codex_auth_ok=true
        else
          _codex_auth_ok=false
        fi
      else
        _codex_auth_ok=false
      fi
    else
      _codex_auth_ok=true
    fi

    if ! $_codex_auth_ok; then
      # Final check via Codex CLI status (non-interactive)
      local status_out status_rc
      status_out=$("${SKYNET_CODEX_BIN:-codex}" login status 2>/dev/null || true)
      status_rc=$?
      if [ "$status_rc" -eq 0 ]; then
        _codex_auth_ok=true
      fi
    fi
  fi

  if $_codex_auth_ok; then
    # Auth looks good — clear any previous failure state
    if [ -f "${SKYNET_CODEX_AUTH_FAIL_FLAG:-}" ]; then
      rm -f "$SKYNET_CODEX_AUTH_FAIL_FLAG"
      log "Codex CLI auth restored."
      tg "✅ *$SKYNET_PROJECT_NAME_UPPER CODEX RESTORED* — Codex CLI authenticated again."
      if [ -f "$BLOCKERS" ]; then
        grep -v "Codex CLI authentication" "$BLOCKERS" > "$BLOCKERS.tmp" || true
        mv "$BLOCKERS.tmp" "$BLOCKERS"
      fi
    fi
    return 0
  fi

  # Auth missing — throttle notifications
  local now
  now=$(date +%s)
  local should_notify=true

  if [ -f "${SKYNET_CODEX_AUTH_FAIL_FLAG:-}" ]; then
    local last_notify
    last_notify=$(cat "$SKYNET_CODEX_AUTH_FAIL_FLAG")
    local elapsed=$((now - last_notify))
    if [ "$elapsed" -lt "$CODEX_NOTIFY_INTERVAL" ]; then
      should_notify=false
    fi
  fi

  if $should_notify; then
    echo "$now" > "$SKYNET_CODEX_AUTH_FAIL_FLAG"
    tg "🟡 *$SKYNET_PROJECT_NAME_UPPER CODEX AUTH MISSING* — Run \`codex\` to login (ChatGPT). Fallback agent unavailable."
    log "Codex CLI not authenticated. Telegram alert sent."
    if ! grep -q "Codex CLI authentication" "$BLOCKERS" 2>/dev/null; then
      echo "- **$(date '+%Y-%m-%d %H:%M')**: Codex CLI authentication missing. Run \`codex\` to login. Fallback agent unavailable." >> "$BLOCKERS"
    fi
  else
    log "Codex CLI not authenticated. (alert throttled, next in $((CODEX_NOTIFY_INTERVAL - elapsed))s)"
  fi

  return 1
}

# Accept Claude or Codex auth. Returns 0 if either is available.
check_any_auth() {
  if check_claude_auth; then
    return 0
  fi
  if check_codex_auth; then
    log "Claude auth down — using Codex fallback."
    return 0
  fi
  return 1
}
