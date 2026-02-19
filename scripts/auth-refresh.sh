#!/usr/bin/env bash
# auth-refresh.sh — Auto-refresh Claude Code OAuth tokens before they expire
#
# Reads credentials from macOS Keychain, checks expiry, refreshes if needed,
# and writes new tokens back. Also exports the current access token to a
# cache file so cron jobs (which can't access Keychain) can read it.
#
# MUST run via LaunchAgent (not cron) — requires user session for Keychain.

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_config.sh"

LOG="$SCRIPTS_DIR/auth-refresh.log"
TOKEN_CACHE="$SKYNET_AUTH_TOKEN_CACHE"
KEYCHAIN_SERVICE="Claude Code-credentials"
KEYCHAIN_ACCOUNT="$SKYNET_AUTH_KEYCHAIN_ACCOUNT"
CLIENT_ID="9d1c250a-e61b-44d9-88ed-5944d1962f5e"
TOKEN_URL="https://platform.claude.com/v1/oauth/token"
SCOPE="user:profile user:inference user:sessions:claude_code user:mcp_servers"
# Refresh when less than this many seconds remain (default: 30 min)
REFRESH_BUFFER_SECS=${REFRESH_BUFFER_SECS:-1800}

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"
}

# --- Read current credentials from Keychain ---
read_keychain() {
  security find-generic-password -s "$KEYCHAIN_SERVICE" -a "$KEYCHAIN_ACCOUNT" -w 2>/dev/null
}

# --- Write updated credentials back to Keychain ---
write_keychain() {
  local data="$1"
  security delete-generic-password -s "$KEYCHAIN_SERVICE" -a "$KEYCHAIN_ACCOUNT" >/dev/null 2>&1 || true
  security add-generic-password -s "$KEYCHAIN_SERVICE" -a "$KEYCHAIN_ACCOUNT" -w "$data"
}

# --- Main ---
main() {
  local creds_json
  creds_json=$(read_keychain) || {
    log "ERROR: Could not read credentials from Keychain."
    exit 1
  }

  # Parse all fields with a single python3 call (safe, no shell interpolation)
  local parsed
  parsed=$(echo "$creds_json" | python3 -c "
import json, sys
d = json.load(sys.stdin)['claudeAiOauth']
print(d['accessToken'])
print(d['refreshToken'])
print(d['expiresAt'])
print(json.dumps(d.get('scopes', [])))
print(d.get('subscriptionType', ''))
print(d.get('rateLimitTier', ''))
")

  local access_token refresh_token expires_at scopes subscription_type rate_limit_tier
  {
    read -r access_token
    read -r refresh_token
    read -r expires_at
    read -r scopes
    read -r subscription_type
    read -r rate_limit_tier
  } <<< "$parsed"

  # Check if refresh is needed
  local now_ms
  now_ms=$(python3 -c "import time; print(int(time.time() * 1000))")
  local remaining_secs=$(( (expires_at - now_ms) / 1000 ))

  # Always export current token to cache file for cron scripts
  echo "$access_token" > "$TOKEN_CACHE"
  chmod 600 "$TOKEN_CACHE"

  if [ "$remaining_secs" -gt "$REFRESH_BUFFER_SECS" ]; then
    log "Token still valid for ${remaining_secs}s ($(( remaining_secs / 60 ))m). No refresh needed."
    exit 0
  fi

  log "Token expires in ${remaining_secs}s ($(( remaining_secs / 60 ))m). Refreshing..."

  # Build request body safely via python env vars
  local request_body
  request_body=$(RTOKEN="$refresh_token" CID="$CLIENT_ID" RSCOPE="$SCOPE" python3 -c "
import json, os
print(json.dumps({
    'grant_type': 'refresh_token',
    'refresh_token': os.environ['RTOKEN'],
    'client_id': os.environ['CID'],
    'scope': os.environ['RSCOPE']
}))
")

  # Call the refresh endpoint
  local response http_code body
  response=$(curl -s -w "\n%{http_code}" -X POST "$TOKEN_URL" \
    -H "Content-Type: application/json" \
    -d "$request_body")

  http_code=$(echo "$response" | tail -1)
  body=$(echo "$response" | sed '$d')

  if [ "$http_code" != "200" ]; then
    log "ERROR: Token refresh failed (HTTP $http_code): $body"
    exit 1
  fi

  # Parse response with single python call
  local resp_parsed
  resp_parsed=$(echo "$body" | python3 -c "
import json, sys, time
d = json.load(sys.stdin)
new_access = d['access_token']
new_refresh = d.get('refresh_token', '')
expires_in = d['expires_in']
new_expires_at = int(time.time() * 1000 + expires_in * 1000)
print(new_access)
print(new_refresh)
print(expires_in)
print(new_expires_at)
")

  local new_access new_refresh _expires_in new_expires_at
  {
    read -r new_access
    read -r new_refresh
    read -r _expires_in
    read -r new_expires_at
  } <<< "$resp_parsed"

  # Use new refresh token if provided, otherwise keep the old one
  if [ -z "$new_refresh" ]; then
    new_refresh="$refresh_token"
  fi

  # Build new credential JSON safely via env vars
  local new_creds
  new_creds=$(
    NA="$new_access" NR="$new_refresh" NEA="$new_expires_at" \
    SC="$scopes" ST="$subscription_type" RLT="$rate_limit_tier" \
    python3 -c "
import json, os
creds = {
    'claudeAiOauth': {
        'accessToken': os.environ['NA'],
        'refreshToken': os.environ['NR'],
        'expiresAt': int(os.environ['NEA']),
        'scopes': json.loads(os.environ['SC']),
        'subscriptionType': os.environ['ST'],
        'rateLimitTier': os.environ['RLT']
    }
}
print(json.dumps(creds))
")

  # Write back to Keychain
  write_keychain "$new_creds"

  # Export new token to cache file for cron scripts
  echo "$new_access" > "$TOKEN_CACHE"
  chmod 600 "$TOKEN_CACHE"

  local now_after
  now_after=$(python3 -c "import time; print(int(time.time() * 1000))")
  local new_remaining=$(( (new_expires_at - now_after) / 1000 ))
  log "Token refreshed successfully. New token valid for ${new_remaining}s ($(( new_remaining / 60 ))m)."
}

main "$@"
