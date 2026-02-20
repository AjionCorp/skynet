#!/usr/bin/env bash
# codex-auth-refresh.sh — Auto-refresh Codex OAuth tokens before they expire
#
# Uses refresh_token from ~/.codex/auth.json, discovers token endpoint from
# issuer's OIDC config, refreshes tokens, and writes back updated auth.json.

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_config.sh"

LOG="$SCRIPTS_DIR/codex-auth-refresh.log"
AUTH_FILE="$SKYNET_CODEX_AUTH_FILE"
REFRESH_BUFFER_SECS="${SKYNET_CODEX_REFRESH_BUFFER_SECS:-900}"
ISSUER_OVERRIDE="${SKYNET_CODEX_OAUTH_ISSUER:-}"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"
}

main() {
  if [ -n "${OPENAI_API_KEY:-}" ]; then
    log "OPENAI_API_KEY set — skipping Codex OAuth refresh."
    exit 0
  fi

  if [ ! -f "$AUTH_FILE" ] || [ ! -s "$AUTH_FILE" ]; then
    log "ERROR: Codex auth file missing or empty: $AUTH_FILE"
    exit 1
  fi

  local parsed
  parsed=$(AUTH_FILE="$AUTH_FILE" python3 - <<'PY'
import base64, json, os, sys, time
p = os.environ.get('AUTH_FILE')
with open(p) as f:
    data = json.load(f)

tokens = data.get('tokens', {})
refresh = tokens.get('refresh_token', '')
access = tokens.get('access_token', '')
id_token = tokens.get('id_token', '') or access

auth_mode = data.get('auth_mode', '')
issuer = ''
client_id = ''
exp = 0

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

if id_token:
    claims = decode_claims(id_token)
    issuer = claims.get('iss', '') or ''
    exp = claims.get('exp', 0) or 0
    aud = claims.get('aud')
    if isinstance(aud, list) and aud:
        client_id = aud[0]
    elif isinstance(aud, str):
        client_id = aud
    if not client_id:
        client_id = claims.get('azp', '') or ''

print(refresh)
print(access)
print(id_token)
print(issuer)
print(client_id)
print(exp)
print(auth_mode)
PY
)

  local refresh_token access_token id_token issuer client_id exp auth_mode
  {
    read -r refresh_token
    read -r access_token
    read -r id_token
    read -r issuer
    read -r client_id
    read -r exp
    read -r auth_mode
  } <<< "$parsed"

  if [ -z "$refresh_token" ]; then
    log "ERROR: Missing refresh_token in $AUTH_FILE"
    exit 1
  fi

  if [ -z "$issuer" ] && [ -n "$ISSUER_OVERRIDE" ]; then
    issuer="$ISSUER_OVERRIDE"
  fi

  if [ -z "$issuer" ]; then
    log "ERROR: Missing issuer in token claims and no SKYNET_CODEX_OAUTH_ISSUER set"
    exit 1
  fi

  local now remaining
  now=$(date +%s)
  remaining=$(( exp > 0 ? exp - now : 0 ))

  if [ "$exp" -gt 0 ] && [ "$remaining" -gt "$REFRESH_BUFFER_SECS" ]; then
    log "Token still valid for ${remaining}s ($(( remaining / 60 ))m). No refresh needed."
    exit 0
  fi

  log "Refreshing Codex OAuth token (remaining=${remaining}s)."

  local discovery_url token_endpoint
  discovery_url="${issuer%/}/.well-known/openid-configuration"
  local discovery_json
  discovery_json=$(curl -s "$discovery_url" || true)
  if [ -z "$discovery_json" ]; then
    log "WARN: OIDC discovery returned empty response: $discovery_url"
    local status_out
    status_out=$("${SKYNET_CODEX_BIN:-codex}" login status 2>/dev/null || true)
    if echo "$status_out" | grep -qi "logged in"; then
      log "Codex CLI reports logged in. Skipping OAuth refresh."
      exit 0
    fi
    log "ERROR: Codex CLI not logged in and discovery failed."
    exit 1
  fi
  token_endpoint=$(echo "$discovery_json" | python3 -c "import json,sys; print(json.load(sys.stdin).get('token_endpoint',''))" || true)

  if [ -z "$token_endpoint" ]; then
    log "ERROR: Could not discover token_endpoint from $discovery_url"
    exit 1
  fi

  if [ -z "$client_id" ]; then
    log "ERROR: Missing client_id (aud/azp) in token claims"
    exit 1
  fi

  local response http_code body
  response=$(curl -s -w "\n%{http_code}" -X POST "$token_endpoint" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    --data-urlencode "grant_type=refresh_token" \
    --data-urlencode "refresh_token=$refresh_token" \
    --data-urlencode "client_id=$client_id")

  http_code=$(echo "$response" | tail -1)
  body=$(echo "$response" | sed '$d')

  if [ "$http_code" != "200" ]; then
    log "ERROR: Token refresh failed (HTTP $http_code)"
    exit 1
  fi

  local new_parsed
  new_parsed=$(echo "$body" | python3 - <<'PY'
import json, sys, time
try:
    d = json.load(sys.stdin)
except Exception:
    print("", "", "", sep="\n")
    raise SystemExit
print(d.get('access_token',''))
print(d.get('id_token',''))
print(d.get('refresh_token',''))
PY
)

  local new_access new_id new_refresh
  {
    read -r new_access
    read -r new_id
    read -r new_refresh
  } <<< "$new_parsed"

  if [ -z "$new_access" ] && [ -z "$new_id" ]; then
    log "ERROR: Token refresh response missing access_token/id_token"
    exit 1
  fi

  [ -z "$new_access" ] && new_access="$access_token"
  [ -z "$new_id" ] && new_id="$id_token"
  [ -z "$new_refresh" ] && new_refresh="$refresh_token"

  AUTH_FILE="$AUTH_FILE" NEW_ACCESS="$new_access" NEW_ID="$new_id" NEW_REFRESH="$new_refresh" python3 - <<'PY'
import json, os, time
p = os.environ['AUTH_FILE']
with open(p) as f:
    data = json.load(f)

tokens = data.get('tokens', {})
tokens['access_token'] = os.environ['NEW_ACCESS']
tokens['id_token'] = os.environ['NEW_ID']
tokens['refresh_token'] = os.environ['NEW_REFRESH']
data['tokens'] = tokens
data['last_refresh'] = int(time.time())

out = p + '.tmp'
with open(out, 'w') as f:
    json.dump(data, f)

os.replace(out, p)
PY

  chmod 600 "$AUTH_FILE" 2>/dev/null || true
  log "Token refreshed successfully."
}

main "$@"
