#!/usr/bin/env bash
# tests/unit/codex-auth-refresh.test.sh — Unit tests for scripts/codex-auth-refresh.sh
#
# Tests: OPENAI_API_KEY skip, auth file guards, refresh_token guard, token validity,
# issuer resolution (claims + override), OIDC discovery, token refresh lifecycle,
# HTTP failure handling, token fallback, auth.json write-back, configurable buffer,
# missing client_id, empty refresh response, auth_mode preservation.
#
# Usage: bash tests/unit/codex-auth-refresh.test.sh

# NOTE: -e is intentionally omitted — the test uses its own PASS/FAIL counters
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PASS=0
FAIL=0

log()  { printf "  %s\n" "$*"; }
pass() { PASS=$((PASS + 1)); printf "  \033[32m✓\033[0m %s\n" "$*"; }
fail() { FAIL=$((FAIL + 1)); printf "  \033[31m✗\033[0m %s\n" "$*"; }

assert_eq() {
  local actual="$1" expected="$2" msg="$3"
  if [ "$actual" = "$expected" ]; then
    pass "$msg"
  else
    fail "$msg (expected '$expected', got '$actual')"
  fi
}

assert_contains() {
  local haystack="$1" needle="$2" msg="$3"
  if printf '%s' "$haystack" | grep -qF "$needle"; then
    pass "$msg"
  else
    fail "$msg (expected to contain '$needle')"
  fi
}

assert_not_contains() {
  local haystack="$1" needle="$2" msg="$3"
  if printf '%s' "$haystack" | grep -qF "$needle"; then
    fail "$msg (should NOT contain '$needle')"
  else
    pass "$msg"
  fi
}

# ── Setup: create isolated environment ──────────────────────────────

TMPDIR_ROOT=$(mktemp -d)
cleanup() { rm -rf "$TMPDIR_ROOT"; }
trap cleanup EXIT
ORIG_PATH="$PATH"

MOCK_SCRIPTS_DIR="$TMPDIR_ROOT/scripts"
MOCK_DEV_DIR="$TMPDIR_ROOT/.dev"
MOCK_BIN="$TMPDIR_ROOT/mock-bin"
MOCK_AUTH_DIR="$TMPDIR_ROOT/codex-home"
mkdir -p "$MOCK_SCRIPTS_DIR" "$MOCK_DEV_DIR/scripts" "$MOCK_BIN" "$MOCK_AUTH_DIR"

AUTH_FILE="$MOCK_AUTH_DIR/auth.json"
LOG_FILE="$MOCK_DEV_DIR/scripts/codex-auth-refresh.log"

# Copy the script under test
cp "$REPO_ROOT/scripts/codex-auth-refresh.sh" "$MOCK_SCRIPTS_DIR/codex-auth-refresh.sh"

# Write _config.sh stub — provides vars that codex-auth-refresh.sh needs
cat > "$MOCK_SCRIPTS_DIR/_config.sh" << STUB
SCRIPTS_DIR="$MOCK_DEV_DIR/scripts"
LOG_DIR="\$SCRIPTS_DIR"
export SKYNET_CODEX_AUTH_FILE="\${SKYNET_CODEX_AUTH_FILE:-$AUTH_FILE}"
export SKYNET_CODEX_REFRESH_BUFFER_SECS="\${SKYNET_CODEX_REFRESH_BUFFER_SECS:-900}"
export SKYNET_CODEX_OAUTH_ISSUER="\${SKYNET_CODEX_OAUTH_ISSUER:-}"
export SKYNET_CODEX_BIN="\${SKYNET_CODEX_BIN:-codex}"
STUB

# ── Helpers ─────────────────────────────────────────────────────────

# Build a JWT-like token with given claims JSON
# Output: header.base64url(claims).signature
build_jwt() {
  local claims_json="$1"
  python3 -c "
import base64, sys
payload = base64.urlsafe_b64encode(sys.argv[1].encode()).decode().rstrip('=')
print('eyJhbGciOiJSUzI1NiJ9.' + payload + '.fake-sig')
" "$claims_json"
}

# Build auth.json with given tokens and optional auth_mode
build_auth_json() {
  local access="$1" id_token="$2" refresh="$3" auth_mode="${4:-oauth}"
  python3 -c "
import json, sys
data = {
    'auth_mode': sys.argv[4],
    'tokens': {
        'access_token': sys.argv[1],
        'id_token': sys.argv[2],
        'refresh_token': sys.argv[3]
    }
}
print(json.dumps(data))
" "$access" "$id_token" "$refresh" "$auth_mode"
}

# Build OIDC discovery response JSON
build_discovery_response() {
  local token_endpoint="$1"
  python3 -c "
import json, sys
print(json.dumps({'token_endpoint': sys.argv[1]}))
" "$token_endpoint"
}

# Build token refresh response JSON (empty strings omit the field)
build_refresh_response() {
  local access="$1" id_token="$2" refresh="$3"
  python3 -c "
import json, sys
resp = {}
if sys.argv[1]: resp['access_token'] = sys.argv[1]
if sys.argv[2]: resp['id_token'] = sys.argv[2]
if sys.argv[3]: resp['refresh_token'] = sys.argv[3]
print(json.dumps(resp))
" "$access" "$id_token" "$refresh"
}

# Create mock curl that handles OIDC discovery and token refresh.
# Reads responses from files:
#   $TMPDIR_ROOT/mock-discovery-response  — body for /.well-known/ URLs
#   $TMPDIR_ROOT/mock-refresh-response    — body for token endpoint
#   $TMPDIR_ROOT/mock-refresh-http-code   — HTTP code for token endpoint
setup_mock_curl() {
  local discovery_body="${1:-}" refresh_body="${2:-}" refresh_http_code="${3:-200}"

  [ -n "$discovery_body" ] && printf '%s' "$discovery_body" > "$TMPDIR_ROOT/mock-discovery-response"
  [ -n "$refresh_body" ] && printf '%s' "$refresh_body" > "$TMPDIR_ROOT/mock-refresh-response"
  printf '%s' "$refresh_http_code" > "$TMPDIR_ROOT/mock-refresh-http-code"
  rm -f "$TMPDIR_ROOT/mock-curl-called" "$TMPDIR_ROOT/mock-curl-params"

  cat > "$MOCK_BIN/curl" << MOCK_CURL
#!/usr/bin/env bash
url=""
write_out=""
data_params=()

while [ \$# -gt 0 ]; do
  case "\$1" in
    -s) shift ;;
    -w) write_out="\$2"; shift 2 ;;
    -X) shift 2 ;;
    -H) shift 2 ;;
    --data-urlencode) data_params+=("\$2"); shift 2 ;;
    http://*|https://*) url="\$1"; shift ;;
    *) shift ;;
  esac
done

echo "\$url" >> "$TMPDIR_ROOT/mock-curl-called"
if [ \${#data_params[@]} -gt 0 ]; then
  printf '%s\n' "\${data_params[@]}" > "$TMPDIR_ROOT/mock-curl-params"
fi

case "\$url" in
  */.well-known/openid-configuration*)
    if [ -f "$TMPDIR_ROOT/mock-discovery-response" ]; then
      cat "$TMPDIR_ROOT/mock-discovery-response"
    fi
    ;;
  *)
    if [ -f "$TMPDIR_ROOT/mock-refresh-response" ]; then
      cat "$TMPDIR_ROOT/mock-refresh-response"
    fi
    http_code=\$(cat "$TMPDIR_ROOT/mock-refresh-http-code" 2>/dev/null || echo "200")
    if [ -n "\$write_out" ]; then
      printf '\n%s' "\$http_code"
    fi
    ;;
esac
MOCK_CURL
  chmod +x "$MOCK_BIN/curl"
}

# Create mock codex binary for login status fallback
setup_mock_codex() {
  local status_output="$1"
  cat > "$MOCK_BIN/codex" << MOCK_CODEX
#!/usr/bin/env bash
echo "$status_output"
MOCK_CODEX
  chmod +x "$MOCK_BIN/codex"
}

# Run codex-auth-refresh.sh with mocked environment
run_codex_auth_refresh() {
  rm -f "$LOG_FILE"

  env \
    PATH="$MOCK_BIN:$ORIG_PATH" \
    OPENAI_API_KEY="${TEST_OPENAI_API_KEY:-}" \
    SKYNET_CODEX_AUTH_FILE="$AUTH_FILE" \
    SKYNET_CODEX_REFRESH_BUFFER_SECS="${TEST_REFRESH_BUFFER:-900}" \
    SKYNET_CODEX_OAUTH_ISSUER="${TEST_ISSUER_OVERRIDE:-}" \
    SKYNET_CODEX_BIN="${TEST_CODEX_BIN:-codex}" \
    bash "$MOCK_SCRIPTS_DIR/codex-auth-refresh.sh" 2>/dev/null
}

# Reset state between tests
reset_state() {
  rm -f "$AUTH_FILE" "$LOG_FILE"
  rm -f "$TMPDIR_ROOT/mock-curl-called" "$TMPDIR_ROOT/mock-curl-params"
  rm -f "$TMPDIR_ROOT/mock-discovery-response" "$TMPDIR_ROOT/mock-refresh-response"
  rm -f "$TMPDIR_ROOT/mock-refresh-http-code"
  TEST_OPENAI_API_KEY=""
  TEST_REFRESH_BUFFER=900
  TEST_ISSUER_OVERRIDE=""
  TEST_CODEX_BIN="codex"
}

# ── Test: OPENAI_API_KEY set — skip refresh ──────────────────────────

echo ""
log "=== OPENAI_API_KEY skip ==="

reset_state
TEST_OPENAI_API_KEY="sk-test-123"

if run_codex_auth_refresh; then
  pass "exits 0 when OPENAI_API_KEY is set"
else
  fail "should exit 0 when OPENAI_API_KEY is set"
fi

log_content=$(cat "$LOG_FILE" 2>/dev/null || echo "")
assert_contains "$log_content" "OPENAI_API_KEY set" "logs OPENAI_API_KEY skip message"

# ── Test: auth file missing — exits 1 ────────────────────────────────

echo ""
log "=== auth file missing ==="

reset_state

if run_codex_auth_refresh; then
  fail "should exit 1 when auth file is missing"
else
  pass "exits 1 when auth file is missing"
fi

log_content=$(cat "$LOG_FILE" 2>/dev/null || echo "")
assert_contains "$log_content" "auth file missing or empty" "logs auth file missing error"

# ── Test: auth file empty — exits 1 ──────────────────────────────────

echo ""
log "=== auth file empty ==="

reset_state
touch "$AUTH_FILE"

if run_codex_auth_refresh; then
  fail "should exit 1 when auth file is empty"
else
  pass "exits 1 when auth file is empty"
fi

log_content=$(cat "$LOG_FILE" 2>/dev/null || echo "")
assert_contains "$log_content" "auth file missing or empty" "logs auth file empty error"

# ── Test: missing refresh_token — exits 1 ────────────────────────────

echo ""
log "=== missing refresh_token ==="

reset_state
now_s=$(date +%s)
exp_s=$((now_s + 3600))
access_jwt=$(build_jwt "{\"iss\":\"https://auth.example.com\",\"aud\":\"client-123\",\"exp\":$exp_s}")
id_jwt=$(build_jwt "{\"iss\":\"https://auth.example.com\",\"aud\":\"client-123\",\"exp\":$exp_s}")
build_auth_json "$access_jwt" "$id_jwt" "" > "$AUTH_FILE"

if run_codex_auth_refresh; then
  fail "should exit 1 when refresh_token is missing"
else
  pass "exits 1 when refresh_token is missing"
fi

log_content=$(cat "$LOG_FILE" 2>/dev/null || echo "")
assert_contains "$log_content" "Missing refresh_token" "logs missing refresh_token error"

# ── Test: token still valid — no refresh needed ──────────────────────

echo ""
log "=== token still valid (no refresh) ==="

reset_state
now_s=$(date +%s)
exp_s=$((now_s + 3600))
access_jwt=$(build_jwt "{\"iss\":\"https://auth.example.com\",\"aud\":\"client-123\",\"exp\":$exp_s}")
id_jwt=$(build_jwt "{\"iss\":\"https://auth.example.com\",\"aud\":\"client-123\",\"exp\":$exp_s}")
build_auth_json "$access_jwt" "$id_jwt" "valid-refresh-token" > "$AUTH_FILE"

setup_mock_curl "" "" "200"

if run_codex_auth_refresh; then
  pass "exits 0 when token is still valid"
else
  fail "should exit 0 when token is still valid"
fi

# ── Test: no curl when token valid ────────────────────────────────────

echo ""
log "=== no curl when token valid ==="

if [ ! -f "$TMPDIR_ROOT/mock-curl-called" ]; then
  pass "curl NOT called when token has sufficient remaining time"
else
  fail "should NOT call curl when token valid beyond buffer"
fi

# ── Test: log "No refresh needed" ─────────────────────────────────────

echo ""
log "=== log: no refresh needed ==="

log_content=$(cat "$LOG_FILE" 2>/dev/null || echo "")
assert_contains "$log_content" "No refresh needed" "logs 'No refresh needed' when token valid"

# ── Test: refresh triggered when token near expiry ────────────────────

echo ""
log "=== refresh triggered (token near expiry) ==="

reset_state
now_s=$(date +%s)
exp_s=$((now_s + 300))
access_jwt=$(build_jwt "{\"iss\":\"https://auth.example.com\",\"aud\":\"client-123\",\"exp\":$exp_s}")
id_jwt=$(build_jwt "{\"iss\":\"https://auth.example.com\",\"aud\":\"client-123\",\"exp\":$exp_s}")
build_auth_json "$access_jwt" "$id_jwt" "old-refresh-token" > "$AUTH_FILE"

discovery=$(build_discovery_response "https://auth.example.com/oauth/token")
refresh_resp=$(build_refresh_response "new-access-jwt" "new-id-jwt" "new-refresh-token")
setup_mock_curl "$discovery" "$refresh_resp" "200"

if run_codex_auth_refresh; then
  pass "exits 0 on successful refresh"
else
  fail "should exit 0 when refresh succeeds"
fi

if [ -f "$TMPDIR_ROOT/mock-curl-called" ]; then
  pass "curl was called for token refresh"
else
  fail "curl should have been called to refresh token"
fi

# ── Test: auth.json updated with new tokens ──────────────────────────

echo ""
log "=== auth.json updated after refresh ==="

if [ -f "$AUTH_FILE" ]; then
  new_at=$(python3 -c "import json; print(json.load(open('$AUTH_FILE'))['tokens']['access_token'])")
  assert_eq "$new_at" "new-access-jwt" "auth.json has new access_token"

  new_id=$(python3 -c "import json; print(json.load(open('$AUTH_FILE'))['tokens']['id_token'])")
  assert_eq "$new_id" "new-id-jwt" "auth.json has new id_token"

  new_rt=$(python3 -c "import json; print(json.load(open('$AUTH_FILE'))['tokens']['refresh_token'])")
  assert_eq "$new_rt" "new-refresh-token" "auth.json has new refresh_token"

  last_refresh=$(python3 -c "import json; print(json.load(open('$AUTH_FILE')).get('last_refresh', ''))")
  if [ -n "$last_refresh" ] && [ "$last_refresh" -gt 0 ] 2>/dev/null; then
    pass "auth.json has last_refresh timestamp"
  else
    fail "auth.json has last_refresh timestamp (got '$last_refresh')"
  fi
else
  fail "auth.json should exist after refresh"
  fail "skipping access_token check"
  fail "skipping id_token check"
  fail "skipping refresh_token check"
  fail "skipping last_refresh check"
fi

# ── Test: auth.json has secure permissions ───────────────────────────

echo ""
log "=== auth.json permissions ==="

if [ -f "$AUTH_FILE" ]; then
  perms=$(stat -f "%Lp" "$AUTH_FILE" 2>/dev/null || stat -c "%a" "$AUTH_FILE" 2>/dev/null)
  assert_eq "$perms" "600" "auth.json has 600 permissions after refresh"
else
  fail "auth.json must exist for permission check"
fi

# ── Test: log success after refresh ──────────────────────────────────

echo ""
log "=== log: refresh success ==="

log_content=$(cat "$LOG_FILE" 2>/dev/null || echo "")
assert_contains "$log_content" "Token refreshed successfully" "logs success message after refresh"

# ── Test: log "Refreshing" when refresh triggered ─────────────────────

echo ""
log "=== log: refreshing message ==="

assert_contains "$log_content" "Refreshing" "logs 'Refreshing' when refresh is triggered"

# ── Test: HTTP failure exits 1 ───────────────────────────────────────

echo ""
log "=== refresh HTTP failure ==="

reset_state
now_s=$(date +%s)
exp_s=$((now_s + 300))
access_jwt=$(build_jwt "{\"iss\":\"https://auth.example.com\",\"aud\":\"client-123\",\"exp\":$exp_s}")
id_jwt=$(build_jwt "{\"iss\":\"https://auth.example.com\",\"aud\":\"client-123\",\"exp\":$exp_s}")
build_auth_json "$access_jwt" "$id_jwt" "fail-refresh-token" > "$AUTH_FILE"

discovery=$(build_discovery_response "https://auth.example.com/oauth/token")
setup_mock_curl "$discovery" '{"error":"invalid_grant"}' "400"

if run_codex_auth_refresh; then
  fail "should exit 1 when refresh HTTP request fails"
else
  pass "exits 1 when refresh returns non-200"
fi

log_content=$(cat "$LOG_FILE" 2>/dev/null || echo "")
assert_contains "$log_content" "Token refresh failed" "logs HTTP failure message"
assert_contains "$log_content" "400" "logs HTTP status code on failure"

# ── Test: refresh token unchanged when server returns same value ──────

echo ""
log "=== refresh token round-trip ==="

reset_state
now_s=$(date +%s)
exp_s=$((now_s + 300))
access_jwt=$(build_jwt "{\"iss\":\"https://auth.example.com\",\"aud\":\"client-123\",\"exp\":$exp_s}")
id_jwt=$(build_jwt "{\"iss\":\"https://auth.example.com\",\"aud\":\"client-123\",\"exp\":$exp_s}")
build_auth_json "$access_jwt" "$id_jwt" "keep-this-refresh" > "$AUTH_FILE"

discovery=$(build_discovery_response "https://auth.example.com/oauth/token")
# Server returns same refresh_token as sent
refresh_resp=$(build_refresh_response "refreshed-access" "refreshed-id" "keep-this-refresh")
setup_mock_curl "$discovery" "$refresh_resp" "200"

if run_codex_auth_refresh; then
  pass "exits 0 when refresh succeeds (same refresh_token returned)"
else
  fail "should exit 0 when refresh succeeds"
fi

if [ -f "$AUTH_FILE" ]; then
  kept_rt=$(python3 -c "import json; print(json.load(open('$AUTH_FILE'))['tokens']['refresh_token'])")
  assert_eq "$kept_rt" "keep-this-refresh" "refresh_token preserved when server returns same value"

  new_at=$(python3 -c "import json; print(json.load(open('$AUTH_FILE'))['tokens']['access_token'])")
  assert_eq "$new_at" "refreshed-access" "access_token updated in auth.json"

  new_id=$(python3 -c "import json; print(json.load(open('$AUTH_FILE'))['tokens']['id_token'])")
  assert_eq "$new_id" "refreshed-id" "id_token updated in auth.json"
else
  fail "auth.json should exist after refresh"
  fail "skipping refresh_token check"
  fail "skipping access_token check"
  fail "skipping id_token check"
fi

# ── Test: missing issuer with no override — exits 1 ──────────────────

echo ""
log "=== missing issuer (no override) ==="

reset_state
now_s=$(date +%s)
exp_s=$((now_s + 300))
access_jwt=$(build_jwt "{\"aud\":\"client-123\",\"exp\":$exp_s}")
id_jwt=$(build_jwt "{\"aud\":\"client-123\",\"exp\":$exp_s}")
build_auth_json "$access_jwt" "$id_jwt" "some-refresh-token" > "$AUTH_FILE"

if run_codex_auth_refresh; then
  fail "should exit 1 when issuer is missing and no override"
else
  pass "exits 1 when issuer missing and no SKYNET_CODEX_OAUTH_ISSUER"
fi

log_content=$(cat "$LOG_FILE" 2>/dev/null || echo "")
assert_contains "$log_content" "Missing issuer" "logs missing issuer error"

# ── Test: issuer override used when not in claims ─────────────────────

echo ""
log "=== issuer override ==="

reset_state
now_s=$(date +%s)
exp_s=$((now_s + 3600))
access_jwt=$(build_jwt "{\"aud\":\"client-123\",\"exp\":$exp_s}")
id_jwt=$(build_jwt "{\"aud\":\"client-123\",\"exp\":$exp_s}")
build_auth_json "$access_jwt" "$id_jwt" "override-refresh" > "$AUTH_FILE"

TEST_ISSUER_OVERRIDE="https://override.example.com"
setup_mock_curl "" "" "200"

if run_codex_auth_refresh; then
  pass "exits 0 with issuer override (token still valid)"
else
  fail "should exit 0 with issuer override when token valid"
fi

log_content=$(cat "$LOG_FILE" 2>/dev/null || echo "")
assert_contains "$log_content" "No refresh needed" "issuer override allows validity check to proceed"

# ── Test: OIDC discovery empty — fallback to codex CLI (logged in) ────

echo ""
log "=== OIDC discovery empty (codex logged in) ==="

reset_state
now_s=$(date +%s)
exp_s=$((now_s + 300))
access_jwt=$(build_jwt "{\"iss\":\"https://auth.example.com\",\"aud\":\"client-123\",\"exp\":$exp_s}")
id_jwt=$(build_jwt "{\"iss\":\"https://auth.example.com\",\"aud\":\"client-123\",\"exp\":$exp_s}")
build_auth_json "$access_jwt" "$id_jwt" "codex-fallback-refresh" > "$AUTH_FILE"

# Empty discovery response — don't create mock-discovery-response file
setup_mock_curl "" "" "200"
rm -f "$TMPDIR_ROOT/mock-discovery-response"
setup_mock_codex "Logged in as user@example.com"

if run_codex_auth_refresh; then
  pass "exits 0 when discovery empty but codex reports logged in"
else
  fail "should exit 0 when codex CLI reports logged in"
fi

log_content=$(cat "$LOG_FILE" 2>/dev/null || echo "")
assert_contains "$log_content" "Codex CLI reports logged in" "logs codex CLI fallback"

# ── Test: OIDC discovery empty + codex not logged in — exits 1 ────────

echo ""
log "=== OIDC discovery empty (codex NOT logged in) ==="

reset_state
now_s=$(date +%s)
exp_s=$((now_s + 300))
access_jwt=$(build_jwt "{\"iss\":\"https://auth.example.com\",\"aud\":\"client-123\",\"exp\":$exp_s}")
id_jwt=$(build_jwt "{\"iss\":\"https://auth.example.com\",\"aud\":\"client-123\",\"exp\":$exp_s}")
build_auth_json "$access_jwt" "$id_jwt" "codex-fail-refresh" > "$AUTH_FILE"

setup_mock_curl "" "" "200"
rm -f "$TMPDIR_ROOT/mock-discovery-response"
setup_mock_codex "Error: no active session"

if run_codex_auth_refresh; then
  fail "should exit 1 when discovery empty and codex not logged in"
else
  pass "exits 1 when discovery empty and codex not logged in"
fi

log_content=$(cat "$LOG_FILE" 2>/dev/null || echo "")
assert_contains "$log_content" "not logged in and discovery failed" "logs combined failure"

# ── Test: missing client_id — exits 1 ────────────────────────────────

echo ""
log "=== missing client_id ==="

reset_state
now_s=$(date +%s)
exp_s=$((now_s + 300))
# JWT with issuer but no aud/azp claims
access_jwt=$(build_jwt "{\"iss\":\"https://auth.example.com\",\"exp\":$exp_s}")
id_jwt=$(build_jwt "{\"iss\":\"https://auth.example.com\",\"exp\":$exp_s}")
build_auth_json "$access_jwt" "$id_jwt" "no-clientid-refresh" > "$AUTH_FILE"

discovery=$(build_discovery_response "https://auth.example.com/oauth/token")
setup_mock_curl "$discovery" "" "200"

if run_codex_auth_refresh; then
  fail "should exit 1 when client_id is missing"
else
  pass "exits 1 when client_id (aud/azp) is missing"
fi

log_content=$(cat "$LOG_FILE" 2>/dev/null || echo "")
assert_contains "$log_content" "Missing client_id" "logs missing client_id error"

# ── Test: request body contains correct fields ────────────────────────

echo ""
log "=== refresh request body ==="

reset_state
now_s=$(date +%s)
exp_s=$((now_s + 300))
access_jwt=$(build_jwt "{\"iss\":\"https://auth.example.com\",\"aud\":\"test-client-id\",\"exp\":$exp_s}")
id_jwt=$(build_jwt "{\"iss\":\"https://auth.example.com\",\"aud\":\"test-client-id\",\"exp\":$exp_s}")
build_auth_json "$access_jwt" "$id_jwt" "body-check-refresh" > "$AUTH_FILE"

discovery=$(build_discovery_response "https://auth.example.com/oauth/token")
refresh_resp=$(build_refresh_response "body-new-at" "body-new-id" "body-new-rt")
setup_mock_curl "$discovery" "$refresh_resp" "200"

run_codex_auth_refresh || true

if [ -f "$TMPDIR_ROOT/mock-curl-params" ]; then
  params=$(cat "$TMPDIR_ROOT/mock-curl-params")
  assert_contains "$params" "grant_type=refresh_token" "request has grant_type=refresh_token"
  assert_contains "$params" "refresh_token=body-check-refresh" "request has correct refresh_token"
  assert_contains "$params" "client_id=test-client-id" "request has correct client_id"
else
  fail "request has grant_type=refresh_token (no params captured)"
  fail "request has correct refresh_token (no params captured)"
  fail "request has correct client_id (no params captured)"
fi

# ── Test: OIDC discovery URL uses issuer ──────────────────────────────

echo ""
log "=== OIDC discovery URL ==="

if [ -f "$TMPDIR_ROOT/mock-curl-called" ]; then
  curl_urls=$(cat "$TMPDIR_ROOT/mock-curl-called")
  assert_contains "$curl_urls" "https://auth.example.com/.well-known/openid-configuration" \
    "discovery URL derived from token issuer"
else
  fail "discovery URL derived from token issuer (no curl calls captured)"
fi

# ── Test: configurable refresh buffer (triggers refresh) ──────────────

echo ""
log "=== configurable refresh buffer (triggers refresh) ==="

reset_state
now_s=$(date +%s)
exp_s=$((now_s + 600))   # 10 min remaining
access_jwt=$(build_jwt "{\"iss\":\"https://auth.example.com\",\"aud\":\"client-123\",\"exp\":$exp_s}")
id_jwt=$(build_jwt "{\"iss\":\"https://auth.example.com\",\"aud\":\"client-123\",\"exp\":$exp_s}")
build_auth_json "$access_jwt" "$id_jwt" "buffer-test-refresh" > "$AUTH_FILE"

discovery=$(build_discovery_response "https://auth.example.com/oauth/token")
refresh_resp=$(build_refresh_response "buffer-new-at" "buffer-new-id" "buffer-new-rt")
setup_mock_curl "$discovery" "$refresh_resp" "200"

# 15 min buffer > 10 min remaining → should refresh
TEST_REFRESH_BUFFER=900

if run_codex_auth_refresh; then
  pass "exits 0 with custom buffer (15m > 10m remaining)"
else
  fail "should exit 0 with custom refresh buffer"
fi

if [ -f "$TMPDIR_ROOT/mock-curl-called" ]; then
  pass "refresh triggered with larger custom buffer"
else
  fail "should trigger refresh when remaining < custom buffer"
fi

# ── Test: configurable refresh buffer (skips refresh) ─────────────────

echo ""
log "=== configurable refresh buffer (skips refresh) ==="

reset_state
now_s=$(date +%s)
exp_s=$((now_s + 600))   # 10 min remaining
access_jwt=$(build_jwt "{\"iss\":\"https://auth.example.com\",\"aud\":\"client-123\",\"exp\":$exp_s}")
id_jwt=$(build_jwt "{\"iss\":\"https://auth.example.com\",\"aud\":\"client-123\",\"exp\":$exp_s}")
build_auth_json "$access_jwt" "$id_jwt" "buffer-skip-refresh" > "$AUTH_FILE"

setup_mock_curl "" "" "200"

# 5 min buffer < 10 min remaining → should NOT refresh
TEST_REFRESH_BUFFER=300

if run_codex_auth_refresh; then
  pass "exits 0 with small buffer (5m < 10m remaining)"
else
  fail "should exit 0 when remaining > custom buffer"
fi

if [ ! -f "$TMPDIR_ROOT/mock-curl-called" ]; then
  pass "no refresh when remaining (10m) > custom buffer (5m)"
else
  fail "should NOT refresh when remaining exceeds custom buffer"
fi

# ── Test: empty access + id in refresh response — exits 1 ────────────

echo ""
log "=== empty tokens in refresh response ==="

reset_state
now_s=$(date +%s)
exp_s=$((now_s + 300))
access_jwt=$(build_jwt "{\"iss\":\"https://auth.example.com\",\"aud\":\"client-123\",\"exp\":$exp_s}")
id_jwt=$(build_jwt "{\"iss\":\"https://auth.example.com\",\"aud\":\"client-123\",\"exp\":$exp_s}")
build_auth_json "$access_jwt" "$id_jwt" "empty-resp-refresh" > "$AUTH_FILE"

discovery=$(build_discovery_response "https://auth.example.com/oauth/token")
setup_mock_curl "$discovery" '{"refresh_token":"only-refresh"}' "200"

if run_codex_auth_refresh; then
  fail "should exit 1 when response missing both access_token and id_token"
else
  pass "exits 1 when refresh response missing access_token/id_token"
fi

log_content=$(cat "$LOG_FILE" 2>/dev/null || echo "")
assert_contains "$log_content" "missing access_token/id_token" "logs missing tokens error"

# ── Test: auth_mode preserved in write-back ──────────────────────────

echo ""
log "=== auth_mode preserved ==="

reset_state
now_s=$(date +%s)
exp_s=$((now_s + 300))
access_jwt=$(build_jwt "{\"iss\":\"https://auth.example.com\",\"aud\":\"client-123\",\"exp\":$exp_s}")
id_jwt=$(build_jwt "{\"iss\":\"https://auth.example.com\",\"aud\":\"client-123\",\"exp\":$exp_s}")
build_auth_json "$access_jwt" "$id_jwt" "preserve-mode-refresh" "api_key_oauth" > "$AUTH_FILE"

discovery=$(build_discovery_response "https://auth.example.com/oauth/token")
refresh_resp=$(build_refresh_response "mode-new-at" "mode-new-id" "mode-new-rt")
setup_mock_curl "$discovery" "$refresh_resp" "200"

if run_codex_auth_refresh; then
  pass "exits 0 for auth_mode preservation test"
else
  fail "should exit 0 when refresh succeeds"
fi

if [ -f "$AUTH_FILE" ]; then
  auth_mode=$(python3 -c "import json; print(json.load(open('$AUTH_FILE')).get('auth_mode',''))")
  assert_eq "$auth_mode" "api_key_oauth" "auth_mode preserved after refresh"
else
  fail "auth_mode preserved after refresh (auth.json missing)"
fi

# ── Summary ──────────────────────────────────────────────────────────

echo ""
TOTAL=$((PASS + FAIL))
log "Results: $PASS/$TOTAL passed, $FAIL failed"
if [ "$FAIL" -eq 0 ]; then
  printf "  \033[32mAll checks passed!\033[0m\n"
else
  printf "  \033[31mSome checks failed!\033[0m\n"
  exit 1
fi
