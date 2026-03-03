#!/usr/bin/env bash
# tests/unit/auth-refresh.test.sh — Unit tests for scripts/auth-refresh.sh
#
# Tests: read_keychain failure, token validity check, token cache export,
# cache file permissions, refresh trigger, HTTP failure handling,
# successful refresh lifecycle, refresh token retention, keychain write-back,
# configurable refresh buffer, request body correctness.
#
# Usage: bash tests/unit/auth-refresh.test.sh

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

# ── Setup: create isolated environment ──────────────────────────────

TMPDIR_ROOT=$(mktemp -d)
cleanup() { rm -rf "$TMPDIR_ROOT"; }
trap cleanup EXIT
ORIG_PATH="$PATH"

MOCK_BIN="$TMPDIR_ROOT/mock-bin"
mkdir -p "$MOCK_BIN"

# Create a fake .dev directory with skynet.config.sh
FAKE_DEV="$TMPDIR_ROOT/project/.dev"
FAKE_SCRIPTS="$FAKE_DEV/scripts"
mkdir -p "$FAKE_DEV" "$FAKE_SCRIPTS" "$FAKE_DEV/missions" "$FAKE_DEV/skills"

TOKEN_CACHE="$TMPDIR_ROOT/claude-token"

cat > "$FAKE_DEV/skynet.config.sh" <<EOF
export SKYNET_PROJECT_NAME="test-auth-refresh"
export SKYNET_PROJECT_DIR="$TMPDIR_ROOT/project"
export SKYNET_DEV_DIR="$FAKE_DEV"
export SKYNET_NOTIFY_CHANNELS="none"
export SKYNET_LOCK_PREFIX="$TMPDIR_ROOT/locks/skynet-test"
export SKYNET_AUTH_TOKEN_CACHE="$TOKEN_CACHE"
export SKYNET_AUTH_KEYCHAIN_ACCOUNT="testuser"
export SKYNET_WORKTREE_BASE="$TMPDIR_ROOT/worktrees"
export SKYNET_SKILLS_DIR="$FAKE_DEV/skills"
export SKYNET_DB_DEBUG="false"
EOF

mkdir -p "$TMPDIR_ROOT/locks" "$TMPDIR_ROOT/worktrees" "$TMPDIR_ROOT/project"

# ── Helpers ─────────────────────────────────────────────────────────

# Build valid credentials JSON for mocking keychain reads
build_creds_json() {
  local access_token="$1" refresh_token="$2" expires_at="$3"
  python3 -c "
import json, sys
creds = {
    'claudeAiOauth': {
        'accessToken': sys.argv[1],
        'refreshToken': sys.argv[2],
        'expiresAt': int(sys.argv[3]),
        'scopes': ['user:profile', 'user:inference'],
        'subscriptionType': 'pro',
        'rateLimitTier': 'tier1'
    }
}
print(json.dumps(creds))
" "$access_token" "$refresh_token" "$expires_at"
}

# Build refresh endpoint response JSON
build_refresh_response() {
  local access_token="$1" refresh_token="$2" expires_in="$3"
  python3 -c "
import json, sys
resp = {
    'access_token': sys.argv[1],
    'expires_in': int(sys.argv[3])
}
if sys.argv[2]:
    resp['refresh_token'] = sys.argv[2]
print(json.dumps(resp))
" "$access_token" "$refresh_token" "$expires_in"
}

# Create mock security command (macOS Keychain)
setup_mock_security() {
  local mode="$1"  # "ok" or "read-fail"
  local creds_file="$TMPDIR_ROOT/mock-keychain-creds"
  local written_file="$TMPDIR_ROOT/mock-keychain-written"

  rm -f "$written_file"

  cat > "$MOCK_BIN/security" <<MOCK_SEC
#!/usr/bin/env bash
case "\$1" in
  find-generic-password)
    if [ "$mode" = "read-fail" ]; then
      exit 1
    fi
    cat "$creds_file"
    ;;
  delete-generic-password)
    exit 0
    ;;
  add-generic-password)
    # Extract the -w argument
    while [ \$# -gt 0 ]; do
      case "\$1" in
        -w) shift; printf '%s' "\$1" > "$written_file"; break ;;
        *) shift ;;
      esac
    done
    ;;
esac
MOCK_SEC
  chmod +x "$MOCK_BIN/security"
}

# Create mock curl command
setup_mock_curl() {
  local http_code="$1"
  local response_file="$TMPDIR_ROOT/mock-curl-response"
  local curl_called_file="$TMPDIR_ROOT/mock-curl-called"

  rm -f "$curl_called_file"

  cat > "$MOCK_BIN/curl" <<MOCK_CURL
#!/usr/bin/env bash
echo "called" > "$curl_called_file"
# Save the request body (-d arg) for verification
while [ \$# -gt 0 ]; do
  case "\$1" in
    -d) shift; printf '%s' "\$1" > "$TMPDIR_ROOT/mock-curl-body"; break ;;
    *) shift ;;
  esac
done
cat "$response_file"
printf '\n%s' "$http_code"
MOCK_CURL
  chmod +x "$MOCK_BIN/curl"
}

# Run auth-refresh.sh with mocked environment
# Uses TEST_REFRESH_BUFFER (default 1800) for REFRESH_BUFFER_SECS
run_auth_refresh() {
  rm -f "$TOKEN_CACHE" "$FAKE_SCRIPTS/auth-refresh.log"

  env \
    PATH="$MOCK_BIN:$ORIG_PATH" \
    SKYNET_DEV_DIR="$FAKE_DEV" \
    SKYNET_AUTH_TOKEN_CACHE="$TOKEN_CACHE" \
    SKYNET_AUTH_KEYCHAIN_ACCOUNT="testuser" \
    REFRESH_BUFFER_SECS="${TEST_REFRESH_BUFFER:-1800}" \
    bash "$REPO_ROOT/scripts/auth-refresh.sh" 2>/dev/null
}

# ── Test: read_keychain failure exits 1 ─────────────────────────────

echo ""
log "=== read_keychain failure ==="

setup_mock_security "read-fail"

if run_auth_refresh; then
  fail "should exit 1 when keychain read fails"
else
  pass "exits 1 when keychain read fails"
fi

# Check log contains error message
if [ -f "$FAKE_SCRIPTS/auth-refresh.log" ]; then
  log_content=$(cat "$FAKE_SCRIPTS/auth-refresh.log")
  assert_contains "$log_content" "Could not read credentials" "logs keychain read error"
else
  fail "logs keychain read error (log file not created)"
fi

# ── Test: token still valid — no refresh needed ─────────────────────

echo ""
log "=== token still valid (no refresh) ==="

# Create creds with expiry 1 hour from now
future_ms=$(python3 -c "import time; print(int(time.time() * 1000) + 3600000)")
build_creds_json "valid-access-token-123" "valid-refresh-token-456" "$future_ms" \
  > "$TMPDIR_ROOT/mock-keychain-creds"

setup_mock_security "ok"
TEST_REFRESH_BUFFER=1800

if run_auth_refresh; then
  pass "exits 0 when token is still valid"
else
  fail "should exit 0 when token is still valid"
fi

# ── Test: token cache written even without refresh ──────────────────

echo ""
log "=== token cache export (no refresh) ==="

if [ -f "$TOKEN_CACHE" ]; then
  cached_token=$(cat "$TOKEN_CACHE")
  assert_eq "$cached_token" "valid-access-token-123" "cache contains correct access token"
else
  fail "token cache file should be written even when no refresh needed"
fi

# ── Test: token cache has secure permissions ────────────────────────

echo ""
log "=== token cache permissions ==="

if [ -f "$TOKEN_CACHE" ]; then
  perms=$(stat -f "%Lp" "$TOKEN_CACHE" 2>/dev/null || stat -c "%a" "$TOKEN_CACHE" 2>/dev/null)
  assert_eq "$perms" "600" "token cache has 600 permissions"
else
  fail "token cache file must exist for permission check"
fi

# ── Test: log message when no refresh needed ────────────────────────

echo ""
log "=== log: no refresh needed ==="

log_content=$(cat "$FAKE_SCRIPTS/auth-refresh.log" 2>/dev/null || echo "")
assert_contains "$log_content" "No refresh needed" "logs 'No refresh needed' when token valid"

# ── Test: no curl call when token is valid ──────────────────────────

echo ""
log "=== no curl when token valid ==="

# Token expires in 45 minutes (> 30 min default buffer) — should NOT refresh
far_expiry_ms=$(python3 -c "import time; print(int(time.time() * 1000) + 2700000)")
build_creds_json "no-refresh-token" "no-refresh-rt" "$far_expiry_ms" \
  > "$TMPDIR_ROOT/mock-keychain-creds"

setup_mock_security "ok"
setup_mock_curl "200"
rm -f "$TMPDIR_ROOT/mock-curl-called"

if run_auth_refresh; then
  pass "exits 0 when token valid beyond buffer"
else
  fail "should exit 0 when token valid beyond buffer"
fi

if [ ! -f "$TMPDIR_ROOT/mock-curl-called" ]; then
  pass "curl NOT called when token has sufficient remaining time"
else
  fail "should NOT call curl when token has 45m remaining (buffer=30m)"
fi

# ── Test: refresh triggered when token near expiry ──────────────────

echo ""
log "=== refresh triggered (token near expiry) ==="

# Create creds with expiry 5 minutes from now (< 30 min buffer)
near_expiry_ms=$(python3 -c "import time; print(int(time.time() * 1000) + 300000)")
build_creds_json "old-access-token" "old-refresh-token" "$near_expiry_ms" \
  > "$TMPDIR_ROOT/mock-keychain-creds"

# Set up successful refresh response
build_refresh_response "new-access-token-abc" "new-refresh-token-xyz" "3600" \
  > "$TMPDIR_ROOT/mock-curl-response"

setup_mock_security "ok"
setup_mock_curl "200"

if run_auth_refresh; then
  pass "exits 0 on successful refresh"
else
  fail "should exit 0 when refresh succeeds"
fi

# Verify curl was called
if [ -f "$TMPDIR_ROOT/mock-curl-called" ]; then
  pass "curl was called for token refresh"
else
  fail "curl should have been called to refresh token"
fi

# ── Test: new token written to cache after refresh ──────────────────

echo ""
log "=== new token in cache after refresh ==="

if [ -f "$TOKEN_CACHE" ]; then
  cached_token=$(cat "$TOKEN_CACHE")
  assert_eq "$cached_token" "new-access-token-abc" "cache updated with new access token"
else
  fail "token cache should be written after refresh"
fi

# ── Test: new credentials written to keychain ───────────────────────

echo ""
log "=== keychain write-back after refresh ==="

written_file="$TMPDIR_ROOT/mock-keychain-written"
if [ -f "$written_file" ]; then
  written_json=$(cat "$written_file")

  # Verify the written JSON contains the new access token
  new_at=$(echo "$written_json" | python3 -c "import json,sys; print(json.load(sys.stdin)['claudeAiOauth']['accessToken'])")
  assert_eq "$new_at" "new-access-token-abc" "keychain updated with new access token"

  # Verify the written JSON contains the new refresh token
  new_rt=$(echo "$written_json" | python3 -c "import json,sys; print(json.load(sys.stdin)['claudeAiOauth']['refreshToken'])")
  assert_eq "$new_rt" "new-refresh-token-xyz" "keychain updated with new refresh token"

  # Verify metadata preserved from original credentials
  sub_type=$(echo "$written_json" | python3 -c "import json,sys; print(json.load(sys.stdin)['claudeAiOauth']['subscriptionType'])")
  assert_eq "$sub_type" "pro" "keychain preserves subscriptionType"

  rate_tier=$(echo "$written_json" | python3 -c "import json,sys; print(json.load(sys.stdin)['claudeAiOauth']['rateLimitTier'])")
  assert_eq "$rate_tier" "tier1" "keychain preserves rateLimitTier"

  # Verify expiresAt is stored as integer
  expires_type=$(echo "$written_json" | python3 -c "
import json, sys
v = json.load(sys.stdin)['claudeAiOauth']['expiresAt']
print(type(v).__name__)
")
  assert_eq "$expires_type" "int" "expiresAt stored as integer, not string"
else
  fail "keychain should be written after refresh"
  fail "skipping access token check (no write captured)"
  fail "skipping refresh token check (no write captured)"
  fail "skipping subscriptionType check (no write captured)"
  fail "skipping rateLimitTier check (no write captured)"
  fail "skipping expiresAt type check (no write captured)"
fi

# ── Test: log message on successful refresh ─────────────────────────

echo ""
log "=== log: refresh success ==="

log_content=$(cat "$FAKE_SCRIPTS/auth-refresh.log" 2>/dev/null || echo "")
assert_contains "$log_content" "Token refreshed successfully" "logs success message after refresh"

# ── Test: refresh HTTP failure exits 1 ──────────────────────────────

echo ""
log "=== refresh HTTP failure ==="

near_expiry_ms=$(python3 -c "import time; print(int(time.time() * 1000) + 300000)")
build_creds_json "fail-access-token" "fail-refresh-token" "$near_expiry_ms" \
  > "$TMPDIR_ROOT/mock-keychain-creds"

echo '{"error": "invalid_grant"}' > "$TMPDIR_ROOT/mock-curl-response"
setup_mock_security "ok"
setup_mock_curl "400"

if run_auth_refresh; then
  fail "should exit 1 when refresh HTTP request fails"
else
  pass "exits 1 when refresh returns non-200"
fi

log_content=$(cat "$FAKE_SCRIPTS/auth-refresh.log" 2>/dev/null || echo "")
assert_contains "$log_content" "Token refresh failed" "logs HTTP failure message"
assert_contains "$log_content" "400" "logs HTTP status code on failure"

# ── Test: keeps old refresh token when none in response ─────────────

echo ""
log "=== old refresh token retention ==="

near_expiry_ms=$(python3 -c "import time; print(int(time.time() * 1000) + 300000)")
build_creds_json "old-access-token-2" "keep-this-refresh-token" "$near_expiry_ms" \
  > "$TMPDIR_ROOT/mock-keychain-creds"

# Response with no refresh_token field
build_refresh_response "refreshed-access-token" "" "3600" \
  > "$TMPDIR_ROOT/mock-curl-response"

setup_mock_security "ok"
setup_mock_curl "200"
rm -f "$TMPDIR_ROOT/mock-keychain-written"

if run_auth_refresh; then
  pass "exits 0 when refresh succeeds (no new refresh token in response)"
else
  fail "should exit 0 when refresh succeeds"
fi

# Check that old refresh token was preserved
written_file="$TMPDIR_ROOT/mock-keychain-written"
if [ -f "$written_file" ]; then
  written_rt=$(cat "$written_file" | python3 -c "import json,sys; print(json.load(sys.stdin)['claudeAiOauth']['refreshToken'])")
  assert_eq "$written_rt" "keep-this-refresh-token" "old refresh token preserved when none in response"
else
  fail "old refresh token preserved when none in response (no write captured)"
fi

# ── Test: request body contains correct fields ──────────────────────

echo ""
log "=== refresh request body ==="

if [ -f "$TMPDIR_ROOT/mock-curl-body" ]; then
  body=$(cat "$TMPDIR_ROOT/mock-curl-body")

  grant_type=$(echo "$body" | python3 -c "import json,sys; print(json.load(sys.stdin)['grant_type'])")
  assert_eq "$grant_type" "refresh_token" "request body has grant_type=refresh_token"

  client_id=$(echo "$body" | python3 -c "import json,sys; print(json.load(sys.stdin)['client_id'])")
  assert_eq "$client_id" "9d1c250a-e61b-44d9-88ed-5944d1962f5e" "request body has correct client_id"

  req_rt=$(echo "$body" | python3 -c "import json,sys; print(json.load(sys.stdin)['refresh_token'])")
  assert_eq "$req_rt" "keep-this-refresh-token" "request body includes current refresh token"

  req_scope=$(echo "$body" | python3 -c "import json,sys; print(json.load(sys.stdin)['scope'])")
  assert_contains "$req_scope" "user:inference" "request body includes required scope"
else
  fail "request body has grant_type=refresh_token (no body captured)"
  fail "request body has correct client_id (no body captured)"
  fail "request body includes current refresh token (no body captured)"
  fail "request body includes required scope (no body captured)"
fi

# ── Test: REFRESH_BUFFER_SECS is configurable ───────────────────────

echo ""
log "=== configurable refresh buffer ==="

# Token expires in 10 minutes — with 15-minute buffer, should trigger refresh
near_expiry_ms=$(python3 -c "import time; print(int(time.time() * 1000) + 600000)")
build_creds_json "buffer-test-token" "buffer-test-refresh" "$near_expiry_ms" \
  > "$TMPDIR_ROOT/mock-keychain-creds"

build_refresh_response "buffer-refreshed-token" "buffer-new-refresh" "3600" \
  > "$TMPDIR_ROOT/mock-curl-response"

setup_mock_security "ok"
setup_mock_curl "200"
rm -f "$TMPDIR_ROOT/mock-curl-called"

# Set buffer to 15 minutes (900s) — 10 min remaining < 15 min buffer → should refresh
TEST_REFRESH_BUFFER=900

if run_auth_refresh; then
  pass "exits 0 with custom REFRESH_BUFFER_SECS"
else
  fail "should exit 0 with custom REFRESH_BUFFER_SECS"
fi

if [ -f "$TMPDIR_ROOT/mock-curl-called" ]; then
  pass "refresh triggered with custom buffer (10m remaining < 15m buffer)"
else
  fail "should trigger refresh when remaining < custom buffer"
fi

# Reset for remaining tests
TEST_REFRESH_BUFFER=1800

# ── Test: log contains expiry timing info ───────────────────────────

echo ""
log "=== log: expiry timing ==="

log_content=$(cat "$FAKE_SCRIPTS/auth-refresh.log" 2>/dev/null || echo "")
assert_contains "$log_content" "Refreshing" "logs 'Refreshing' when refresh is triggered"

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
