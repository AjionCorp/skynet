#!/usr/bin/env bash
# tests/unit/sync-runner.test.sh — Unit tests for scripts/sync-runner.sh
#
# Tests: guard validation (undefined, non-array, empty SKYNET_SYNC_ENDPOINTS)
# and endpoint dispatch (success, HTTP errors, HTML detection, JSON errors,
# curl failure, optional endpoints, blocker writing, blocker deduplication).
#
# Usage: bash tests/unit/sync-runner.test.sh

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

assert_not_empty() {
  local val="$1" msg="$2"
  if [ -n "$val" ]; then pass "$msg"
  else fail "$msg (was empty)"; fi
}

# ── Setup: create isolated environment ──────────────────────────────

TMPDIR_ROOT=$(mktemp -d)
cleanup() { rm -rf "$TMPDIR_ROOT"; }
trap cleanup EXIT

MOCK_SCRIPTS_DIR="$TMPDIR_ROOT/scripts"
MOCK_DEV_DIR="$TMPDIR_ROOT/.dev"
MOCK_PROJECT_DIR="$TMPDIR_ROOT/project"
MOCK_BIN_DIR="$TMPDIR_ROOT/bin"
mkdir -p "$MOCK_SCRIPTS_DIR" "$MOCK_DEV_DIR" "$MOCK_PROJECT_DIR" "$MOCK_BIN_DIR"

MOCK_BLOCKERS="$MOCK_DEV_DIR/blockers.md"
MOCK_SYNC_HEALTH="$MOCK_DEV_DIR/sync-health.md"

# Copy the script under test
cp "$REPO_ROOT/scripts/sync-runner.sh" "$MOCK_SCRIPTS_DIR/sync-runner.sh"

# ── Mock curl ───────────────────────────────────────────────────────
# Reads tab-separated responses from MOCK_CURL_RESPONSES file.
# Format per line: url_pattern<TAB>http_code<TAB>body
# Use "fail" as http_code to simulate a network/connection error.

cat > "$MOCK_BIN_DIR/curl" << 'CURL_MOCK'
#!/usr/bin/env bash
url=""
output_file=""
write_out=""
fail_on_error=false

while [ $# -gt 0 ]; do
  case "$1" in
    -o)                   output_file="$2"; shift 2 ;;
    -w)                   write_out="$2"; shift 2 ;;
    -X|-H|--max-time)     shift 2 ;;
    -s)                   shift ;;
    -f)                   fail_on_error=true; shift ;;
    -sf|-fs)              fail_on_error=true; shift ;;
    http://*|https://*)   url="$1"; shift ;;
    *)                    shift ;;
  esac
done

http_code="200"
body='{"data":"ok"}'

if [ -n "$url" ] && [ -f "${MOCK_CURL_RESPONSES:-}" ]; then
  while IFS=$'\t' read -r pattern code resp_body; do
    [ -z "$pattern" ] && continue
    case "$url" in
      *"$pattern"*)
        http_code="$code"
        body="$resp_body"
        break
        ;;
    esac
  done < "$MOCK_CURL_RESPONSES"
fi

if [ "$http_code" = "fail" ]; then
  exit 1
fi

if [ -n "$output_file" ]; then
  printf '%s' "$body" > "$output_file"
fi

if [ "$write_out" = "%{http_code}" ]; then
  printf '%s' "$http_code"
fi

if $fail_on_error && [ "$http_code" -ge 400 ] 2>/dev/null; then
  exit 22
fi

exit 0
CURL_MOCK
chmod +x "$MOCK_BIN_DIR/curl"

# ── Helpers ─────────────────────────────────────────────────────────

# Write a _config.sh stub with the given endpoints block appended verbatim.
write_config() {
  local endpoints_block="$1"
  cat > "$MOCK_SCRIPTS_DIR/_config.sh" << STUB
SCRIPTS_DIR="\$(cd "\$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$MOCK_PROJECT_DIR"
SYNC_HEALTH="$MOCK_SYNC_HEALTH"
BLOCKERS="$MOCK_BLOCKERS"
SKYNET_DEV_SERVER_URL="http://localhost:19999"
SKYNET_LOCK_PREFIX="$TMPDIR_ROOT/locks/skynet-test"
SKYNET_PROJECT_NAME="test-sync"
SKYNET_PROJECT_NAME_UPPER="TEST-SYNC"

_log() {
  local level="\$1" label="\$2" msg="\$3" logfile="\${4:-}"
  local line="[\$label] \$msg"
  if [ -n "\$logfile" ]; then
    printf '%s\\n' "\$line" >> "\$logfile"
  else
    printf '%s\\n' "\$line"
  fi
}
tg() { :; }
acquire_worker_lock() { return 0; }
STUB
  echo "$endpoints_block" >> "$MOCK_SCRIPTS_DIR/_config.sh"
}

# Reset state between tests
reset_state() {
  rm -f "$MOCK_BLOCKERS" "$MOCK_SYNC_HEALTH"
  rm -rf "$TMPDIR_ROOT/locks"
  mkdir -p "$TMPDIR_ROOT/locks"
  rm -f "$TMPDIR_ROOT/curl_responses.tsv"
  : > "$MOCK_BLOCKERS"
}

# Run sync-runner.sh and capture outputs.
# Sets: _rc (exit code), _output (stdout+stderr), _health (sync-health.md),
#       _blockers (blockers.md content)
run_sync_runner() {
  local run_log="$TMPDIR_ROOT/run.log"
  rm -f "$run_log"
  _rc=0
  (
    export PATH="$MOCK_BIN_DIR:$PATH"
    export MOCK_CURL_RESPONSES="$TMPDIR_ROOT/curl_responses.tsv"
    bash "$MOCK_SCRIPTS_DIR/sync-runner.sh" >> "$run_log" 2>&1
  ) || _rc=$?
  _output=""
  [ -f "$run_log" ] && _output=$(cat "$run_log")
  _health=""
  [ -f "$MOCK_SYNC_HEALTH" ] && _health=$(cat "$MOCK_SYNC_HEALTH")
  _blockers=""
  [ -f "$MOCK_BLOCKERS" ] && _blockers=$(cat "$MOCK_BLOCKERS")
}

# Append a mock curl response rule.
# Args: url_pattern http_code body
add_curl_response() {
  printf '%s\t%s\t%s\n' "$1" "$2" "$3" >> "$TMPDIR_ROOT/curl_responses.tsv"
}

echo "sync-runner.test.sh — unit tests for scripts/sync-runner.sh"

# ══════════════════════════════════════════════════════════════════════
# GUARD VALIDATION TESTS
# ══════════════════════════════════════════════════════════════════════

# ── Test: SKYNET_SYNC_ENDPOINTS not defined ──────────────────────────

echo ""
log "=== GUARD: SKYNET_SYNC_ENDPOINTS not defined ==="

reset_state
write_config ""
run_sync_runner

assert_eq "$_rc" "0" "undefined: exit code 0"
assert_contains "$_output" "not defined" "undefined: log warns about not defined"

# ── Test: SKYNET_SYNC_ENDPOINTS is a string (not array) ─────────────

echo ""
log "=== GUARD: SKYNET_SYNC_ENDPOINTS is a string (not array) ==="

reset_state
write_config 'SKYNET_SYNC_ENDPOINTS="foo|/api/sync/foo"'
run_sync_runner

assert_eq "$_rc" "0" "not-array: exit code 0"
assert_contains "$_output" "not an array" "not-array: log warns about not an array"

# ── Test: SKYNET_SYNC_ENDPOINTS is an empty array ───────────────────

echo ""
log "=== GUARD: SKYNET_SYNC_ENDPOINTS is an empty array ==="

# NOTE: In bash, ${arr+x} for a declared-but-empty array returns "" because
# arr[0] is unset. The first guard (not defined) catches this case.
reset_state
write_config 'declare -a SKYNET_SYNC_ENDPOINTS=()'
run_sync_runner

assert_eq "$_rc" "0" "empty-array: exit code 0"
assert_contains "$_output" "not defined" "empty-array: caught by undefined guard"

# ══════════════════════════════════════════════════════════════════════
# ENDPOINT DISPATCH TESTS
# ══════════════════════════════════════════════════════════════════════

# ── Test: Server unreachable → SKIPPED ───────────────────────────────

echo ""
log "=== DISPATCH: server unreachable ==="

reset_state
write_config 'declare -a SKYNET_SYNC_ENDPOINTS=("tasks|/api/sync/tasks")'
add_curl_response "/api/admin/pipeline/status" "fail" ""
run_sync_runner

assert_eq "$_rc" "0" "unreachable: exit code 0"
assert_contains "$_health" "SKIPPED" "unreachable: sync-health says SKIPPED"
assert_contains "$_output" "not reachable" "unreachable: log says not reachable"

# ── Test: Server unreachable with SKYNET_SYNC_STATIC entries ─────────

echo ""
log "=== DISPATCH: server unreachable with static entries ==="

reset_state
write_config '
declare -a SKYNET_SYNC_ENDPOINTS=("tasks|/api/sync/tasks")
declare -a SKYNET_SYNC_STATIC=("| manual-sync | — | ok | — | manually managed |")
'
add_curl_response "/api/admin/pipeline/status" "fail" ""
run_sync_runner

assert_eq "$_rc" "0" "unreachable+static: exit code 0"
assert_contains "$_health" "SKIPPED" "unreachable+static: sync-health says SKIPPED"
assert_contains "$_health" "manual-sync" "unreachable+static: static entry appended"

# ── Test: Single endpoint, success ───────────────────────────────────

echo ""
log "=== DISPATCH: single endpoint success ==="

reset_state
write_config 'declare -a SKYNET_SYNC_ENDPOINTS=("tasks|/api/sync/tasks")'
add_curl_response "/api/admin/pipeline/status" "200" ""
add_curl_response "/api/sync/tasks" "200" '{"data":"ok"}'
run_sync_runner

assert_eq "$_rc" "0" "single-ok: exit code 0"
assert_contains "$_health" "tasks" "single-ok: endpoint name in health"
assert_contains "$_health" "| ok |" "single-ok: status is ok"
assert_eq "$_blockers" "" "single-ok: no blocker written"
assert_contains "$_output" "All available syncs completed OK" "single-ok: success message logged"

# ── Test: HTTP error response (500) ──────────────────────────────────

echo ""
log "=== DISPATCH: HTTP 500 error ==="

reset_state
write_config 'declare -a SKYNET_SYNC_ENDPOINTS=("tasks|/api/sync/tasks")'
add_curl_response "/api/admin/pipeline/status" "200" ""
add_curl_response "/api/sync/tasks" "500" '{"error":"internal"}'
run_sync_runner

assert_eq "$_rc" "0" "http-500: exit code 0"
assert_contains "$_health" "| error |" "http-500: error status in health"
assert_contains "$_health" "HTTP 500" "http-500: HTTP code in notes"
assert_not_empty "$_blockers" "http-500: blocker written"
assert_contains "$_output" "Some syncs had errors" "http-500: error summary logged"

# ── Test: HTML response (auth redirect) ──────────────────────────────

echo ""
log "=== DISPATCH: HTML response detected ==="

reset_state
write_config 'declare -a SKYNET_SYNC_ENDPOINTS=("tasks|/api/sync/tasks")'
add_curl_response "/api/admin/pipeline/status" "200" ""
add_curl_response "/api/sync/tasks" "200" '<html><body>Login</body></html>'
run_sync_runner

assert_eq "$_rc" "0" "html: exit code 0"
assert_contains "$_health" "| error |" "html: error status in health"
assert_contains "$_health" "auth redirect" "html: notes mention auth redirect"

# ── Test: JSON error response ────────────────────────────────────────

echo ""
log "=== DISPATCH: JSON error response ==="

reset_state
write_config 'declare -a SKYNET_SYNC_ENDPOINTS=("tasks|/api/sync/tasks")'
add_curl_response "/api/admin/pipeline/status" "200" ""
add_curl_response "/api/sync/tasks" "200" '{"error":"table not found"}'
run_sync_runner

assert_eq "$_rc" "0" "json-error: exit code 0"
assert_contains "$_health" "| error |" "json-error: error status in health"
assert_contains "$_health" "table not found" "json-error: error message in notes"

# ── Test: JSON "error":null is not treated as error ──────────────────

echo ""
log "=== DISPATCH: JSON error:null is not an error ==="

reset_state
write_config 'declare -a SKYNET_SYNC_ENDPOINTS=("tasks|/api/sync/tasks")'
add_curl_response "/api/admin/pipeline/status" "200" ""
add_curl_response "/api/sync/tasks" "200" '{"data":"ok","error":null}'
run_sync_runner

assert_eq "$_rc" "0" "error-null: exit code 0"
assert_contains "$_health" "| ok |" "error-null: status is ok (not error)"
assert_eq "$_blockers" "" "error-null: no blocker written"

# ── Test: curl failure (network error) ───────────────────────────────

echo ""
log "=== DISPATCH: curl connection failure ==="

reset_state
write_config 'declare -a SKYNET_SYNC_ENDPOINTS=("tasks|/api/sync/tasks")'
add_curl_response "/api/admin/pipeline/status" "200" ""
add_curl_response "/api/sync/tasks" "fail" ""
run_sync_runner

assert_eq "$_rc" "0" "curl-fail: exit code 0"
assert_contains "$_health" "| error |" "curl-fail: error status in health"
assert_contains "$_health" "curl failed" "curl-fail: notes say curl failed"

# ── Test: Optional endpoint present ──────────────────────────────────

echo ""
log "=== DISPATCH: optional endpoint present ==="

reset_state
write_config 'declare -a SKYNET_SYNC_ENDPOINTS=("extras|/api/sync/extras|optional")'
add_curl_response "/api/admin/pipeline/status" "200" ""
add_curl_response "/api/sync/extras" "200" '{"data":"ok"}'
run_sync_runner

assert_eq "$_rc" "0" "optional-present: exit code 0"
assert_contains "$_health" "extras" "optional-present: endpoint in health"
assert_contains "$_health" "| ok |" "optional-present: status is ok"

# ── Test: Optional endpoint absent ───────────────────────────────────

echo ""
log "=== DISPATCH: optional endpoint absent ==="

reset_state
write_config 'declare -a SKYNET_SYNC_ENDPOINTS=("extras|/api/sync/extras|optional")'
add_curl_response "/api/admin/pipeline/status" "200" ""
add_curl_response "/api/sync/extras" "fail" ""
run_sync_runner

assert_eq "$_rc" "0" "optional-absent: exit code 0"
assert_contains "$_health" "extras" "optional-absent: endpoint in health"
assert_contains "$_health" "| pending |" "optional-absent: status is pending"

# ── Test: Multiple endpoints, mixed results ──────────────────────────

echo ""
log "=== DISPATCH: multiple endpoints mixed results ==="

reset_state
write_config 'declare -a SKYNET_SYNC_ENDPOINTS=("tasks|/api/sync/tasks" "users|/api/sync/users" "extras|/api/sync/extras|optional")'
add_curl_response "/api/admin/pipeline/status" "200" ""
add_curl_response "/api/sync/tasks" "200" '{"data":"ok"}'
add_curl_response "/api/sync/users" "500" '{"error":"db down"}'
add_curl_response "/api/sync/extras" "fail" ""
run_sync_runner

assert_eq "$_rc" "0" "multi: exit code 0"
assert_contains "$_health" "tasks" "multi: tasks endpoint in health"
assert_contains "$_health" "users" "multi: users endpoint in health"
assert_contains "$_health" "extras" "multi: extras endpoint in health"
assert_contains "$_output" "Some syncs had errors" "multi: error summary logged"

# ── Test: Error writes to blockers.md ────────────────────────────────

echo ""
log "=== DISPATCH: error writes to blockers.md ==="

reset_state
write_config 'declare -a SKYNET_SYNC_ENDPOINTS=("tasks|/api/sync/tasks")'
add_curl_response "/api/admin/pipeline/status" "200" ""
add_curl_response "/api/sync/tasks" "500" ''
run_sync_runner

assert_not_empty "$_blockers" "blocker-write: blocker file not empty"
assert_contains "$_blockers" "tasks sync error" "blocker-write: endpoint name in blocker"

# ── Test: Blocker deduplication ──────────────────────────────────────

echo ""
log "=== DISPATCH: blocker deduplication ==="

reset_state
write_config 'declare -a SKYNET_SYNC_ENDPOINTS=("tasks|/api/sync/tasks")'
add_curl_response "/api/admin/pipeline/status" "200" ""
add_curl_response "/api/sync/tasks" "500" ''

# Pre-populate blockers with an existing entry for this endpoint
printf -- "- **2026-03-03**: tasks sync error — old error\n" > "$MOCK_BLOCKERS"

run_sync_runner

blocker_count=$(grep -c "tasks sync error" "$MOCK_BLOCKERS" 2>/dev/null || echo "0")
assert_eq "$blocker_count" "1" "blocker-dedup: not duplicated"

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
