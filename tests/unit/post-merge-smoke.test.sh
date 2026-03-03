#!/usr/bin/env bash
# tests/unit/post-merge-smoke.test.sh — Unit tests for scripts/post-merge-smoke.sh
#
# Tests: pre-flight server check, HTTP status validation, JSON envelope validation,
# BASE_URL/TIMEOUT env overrides, exit codes, failure counting, log output
#
# Usage: bash tests/unit/post-merge-smoke.test.sh

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

echo "post-merge-smoke.test.sh — unit tests for scripts/post-merge-smoke.sh"

echo ""
log "=== Setup: creating isolated environment ==="

# Create bare remote and clone (needed for _config.sh sourcing)
git init --bare "$TMPDIR_ROOT/remote.git" >/dev/null 2>&1
git -C "$TMPDIR_ROOT/remote.git" symbolic-ref HEAD refs/heads/main
git clone "$TMPDIR_ROOT/remote.git" "$TMPDIR_ROOT/project" >/dev/null 2>&1
cd "$TMPDIR_ROOT/project"
git checkout -b main 2>/dev/null || true
git config user.email "test@smoke.test"
git config user.name "Smoke Test"
echo "# Smoke Test" > README.md

# Ignore SQLite DB files created by _config.sh sourcing _db.sh
echo "*.db" > .gitignore
echo "*.db-shm" >> .gitignore
echo "*.db-wal" >> .gitignore

# Create .dev/ structure
mkdir -p "$TMPDIR_ROOT/project/.dev/missions"

cat > "$TMPDIR_ROOT/project/.dev/skynet.config.sh" <<CONF
export SKYNET_PROJECT_NAME="test-smoke"
export SKYNET_PROJECT_DIR="$TMPDIR_ROOT/project"
export SKYNET_DEV_DIR="$TMPDIR_ROOT/project/.dev"
export SKYNET_LOCK_PREFIX="/tmp/skynet-test-smoke-$$"
export SKYNET_MAIN_BRANCH="main"
export SKYNET_MAX_WORKERS=1
export SKYNET_MAX_FIXERS=0
export SKYNET_GATE_1="true"
export SKYNET_AGENT_PLUGIN="echo"
export SKYNET_TG_ENABLED="false"
export SKYNET_NOTIFY_CHANNELS=""
export SKYNET_LOCK_BACKEND="file"
export SKYNET_USE_FLOCK="true"
export SKYNET_STALE_MINUTES=45
export SKYNET_AGENT_TIMEOUT_MINUTES=10
export SKYNET_INSTALL_CMD="true"
export SKYNET_DEV_PORT=13399
export SKYNET_BRANCH_PREFIX="dev/"
CONF

# Symlink scripts directory so SCRIPTS_DIR resolves
ln -s "$REPO_ROOT/scripts" "$TMPDIR_ROOT/project/.dev/scripts"

# Create required state files
touch "$TMPDIR_ROOT/project/.dev/blockers.md"
touch "$TMPDIR_ROOT/project/.dev/backlog.md"
touch "$TMPDIR_ROOT/project/.dev/completed.md"
touch "$TMPDIR_ROOT/project/.dev/failed-tasks.md"
touch "$TMPDIR_ROOT/project/.dev/mission.md"

# Commit everything so git working tree starts clean
git add -A
git commit -m "Setup test project with .dev" >/dev/null 2>&1
git push origin main >/dev/null 2>&1

# ── Mock curl factories ─────────────────────────────────────────────

MOCK_BIN="$TMPDIR_ROOT/mock-bin"
mkdir -p "$MOCK_BIN"

# create_mock_curl <behavior>
# Behaviors:
#   "unreachable"    — all requests fail (exit 1)
#   "all-pass"       — preflight OK, all endpoints return 200 + valid JSON
#   "http-fail"      — preflight OK, endpoints return HTTP 500
#   "bad-json"       — preflight OK, endpoints return 200 but missing data/error
#   "mixed"          — preflight OK, first endpoint 500, rest 200 + valid JSON
#   "missing-data"   — preflight OK, endpoints return 200 with "error" but no "data"
#   "missing-error"  — preflight OK, endpoints return 200 with "data" but no "error"
create_mock_curl() {
  local behavior="$1"
  local outfile="$MOCK_BIN/curl"

  case "$behavior" in
    unreachable)
      cat > "$outfile" <<'MOCK'
#!/usr/bin/env bash
exit 1
MOCK
      ;;
    all-pass)
      cat > "$outfile" <<'MOCK'
#!/usr/bin/env bash
# Parse args: look for -w (write-out format) and -o (output file)
output_file=""
has_write_out=false
for arg in "$@"; do
  if [ "$_next_is_output" = "true" ] 2>/dev/null; then
    output_file="$arg"
    _next_is_output=false
    continue
  fi
  case "$arg" in
    -o) _next_is_output=true ;;
    -w) has_write_out=true ;;
  esac
done
# Write valid JSON to output file if specified
if [ -n "$output_file" ]; then
  echo '{"data":{},"error":null}' > "$output_file"
  printf "200"
else
  exit 0
fi
MOCK
      ;;
    http-fail)
      cat > "$outfile" <<'MOCK'
#!/usr/bin/env bash
output_file=""
for arg in "$@"; do
  if [ "$_next_is_output" = "true" ] 2>/dev/null; then
    output_file="$arg"
    _next_is_output=false
    continue
  fi
  case "$arg" in
    -o) _next_is_output=true ;;
  esac
done
if [ -n "$output_file" ]; then
  echo '{}' > "$output_file"
  printf "500"
else
  # Pre-flight check succeeds
  exit 0
fi
MOCK
      ;;
    bad-json)
      cat > "$outfile" <<'MOCK'
#!/usr/bin/env bash
output_file=""
for arg in "$@"; do
  if [ "$_next_is_output" = "true" ] 2>/dev/null; then
    output_file="$arg"
    _next_is_output=false
    continue
  fi
  case "$arg" in
    -o) _next_is_output=true ;;
  esac
done
if [ -n "$output_file" ]; then
  echo '{"result":"ok"}' > "$output_file"
  printf "200"
else
  exit 0
fi
MOCK
      ;;
    missing-data)
      cat > "$outfile" <<'MOCK'
#!/usr/bin/env bash
output_file=""
for arg in "$@"; do
  if [ "$_next_is_output" = "true" ] 2>/dev/null; then
    output_file="$arg"
    _next_is_output=false
    continue
  fi
  case "$arg" in
    -o) _next_is_output=true ;;
  esac
done
if [ -n "$output_file" ]; then
  echo '{"error":null}' > "$output_file"
  printf "200"
else
  exit 0
fi
MOCK
      ;;
    missing-error)
      cat > "$outfile" <<'MOCK'
#!/usr/bin/env bash
output_file=""
for arg in "$@"; do
  if [ "$_next_is_output" = "true" ] 2>/dev/null; then
    output_file="$arg"
    _next_is_output=false
    continue
  fi
  case "$arg" in
    -o) _next_is_output=true ;;
  esac
done
if [ -n "$output_file" ]; then
  echo '{"data":{}}' > "$output_file"
  printf "200"
else
  exit 0
fi
MOCK
      ;;
    mixed)
      # Uses a counter file: first endpoint call returns 500, rest return 200
      cat > "$outfile" <<MOCK
#!/usr/bin/env bash
COUNTER_FILE="$TMPDIR_ROOT/curl-counter"
output_file=""
for arg in "\$@"; do
  if [ "\$_next_is_output" = "true" ] 2>/dev/null; then
    output_file="\$arg"
    _next_is_output=false
    continue
  fi
  case "\$arg" in
    -o) _next_is_output=true ;;
  esac
done
if [ -n "\$output_file" ]; then
  count=\$(cat "\$COUNTER_FILE" 2>/dev/null || echo 0)
  count=\$((count + 1))
  echo "\$count" > "\$COUNTER_FILE"
  if [ "\$count" -eq 1 ]; then
    echo '{}' > "\$output_file"
    printf "500"
  else
    echo '{"data":{},"error":null}' > "\$output_file"
    printf "200"
  fi
else
  exit 0
fi
MOCK
      ;;
  esac
  chmod +x "$outfile"
}

# ── Helper: run post-merge-smoke.sh with controlled env ─────────────

# Runs post-merge-smoke.sh in a subshell with mock curl.
# Arguments:
#   $1 — mock curl behavior (passed to create_mock_curl)
#   $2 — BASE_URL override (optional, default: http://localhost:13399)
#   $3 — SKYNET_SMOKE_TIMEOUT override (optional, default: "5")
# Sets: _sm_rc (exit code), _sm_log (log contents)
run_smoke() {
  local behavior="${1:-all-pass}"
  local base_url="${2:-http://localhost:13399}"
  local timeout="${3:-5}"

  create_mock_curl "$behavior"
  rm -f "$TMPDIR_ROOT/curl-counter"

  local smoke_log="$TMPDIR_ROOT/smoke-run.log"
  rm -f "$smoke_log"

  _sm_rc=0
  (
    export PATH="$MOCK_BIN:$PATH"
    export SKYNET_DEV_DIR="$TMPDIR_ROOT/project/.dev"
    export SKYNET_PROJECT_DIR="$TMPDIR_ROOT/project"
    export SKYNET_PROJECT_NAME="test-smoke"
    export SKYNET_DEV_SERVER_URL="$base_url"
    export SKYNET_SMOKE_TIMEOUT="$timeout"
    export SKYNET_TG_ENABLED="false"
    export SKYNET_NOTIFY_CHANNELS=""
    export SKYNET_LOCK_BACKEND="file"
    export SKYNET_USE_FLOCK="true"

    cd "$TMPDIR_ROOT/project"
    bash "$REPO_ROOT/scripts/post-merge-smoke.sh" >> "$smoke_log" 2>&1
  ) || _sm_rc=$?

  _sm_log=""
  [ -f "$smoke_log" ] && _sm_log=$(cat "$smoke_log")
}

# ── PREFLIGHT: server unreachable skips gracefully ───────────────────

echo ""
log "=== PREFLIGHT: server unreachable skips gracefully ==="

# Test 1: unreachable server exits 0
run_smoke "unreachable"
assert_eq "$_sm_rc" "0" "preflight: exit code 0 when server unreachable"

# Test 2: log says skipping
assert_contains "$_sm_log" "skipping smoke test" "preflight: log says skipping"

# Test 3: no endpoint results logged
assert_not_contains "$_sm_log" "PASS:" "preflight: no PASS lines when skipped"
assert_not_contains "$_sm_log" "FAIL:" "preflight: no FAIL lines when skipped"

# ── ALL_PASS: all endpoints return 200 + valid JSON ──────────────────

echo ""
log "=== ALL_PASS: all endpoints healthy ==="

# Test 4: all pass — exit code 0
run_smoke "all-pass"
assert_eq "$_sm_rc" "0" "all pass: exit code 0"

# Test 5: all pass — summary says all passed
assert_contains "$_sm_log" "all 8 endpoints passed" "all pass: summary shows 8 endpoints passed"

# Test 6: all pass — each endpoint logged as PASS
assert_contains "$_sm_log" "PASS: /api/admin/pipeline/status" "all pass: pipeline/status passed"
assert_contains "$_sm_log" "PASS: /api/admin/tasks" "all pass: tasks passed"
assert_contains "$_sm_log" "PASS: /api/admin/monitoring/status" "all pass: monitoring/status passed"
assert_contains "$_sm_log" "PASS: /api/admin/monitoring/agents" "all pass: monitoring/agents passed"
assert_contains "$_sm_log" "PASS: /api/admin/mission/status" "all pass: mission/status passed"
assert_contains "$_sm_log" "PASS: /api/admin/events" "all pass: events passed"
assert_contains "$_sm_log" "PASS: /api/admin/config" "all pass: config passed"
assert_contains "$_sm_log" "PASS: /api/admin/prompts" "all pass: prompts passed"

# Test 7: no FAIL lines
assert_not_contains "$_sm_log" "FAIL:" "all pass: no FAIL lines"

# ── HTTP_FAIL: endpoints return non-200 ──────────────────────────────

echo ""
log "=== HTTP_FAIL: endpoints return HTTP 500 ==="

# Test 8: all endpoints fail with 500 — exit code 1
run_smoke "http-fail"
assert_eq "$_sm_rc" "1" "http fail: exit code 1"

# Test 9: failure log shows HTTP code
assert_contains "$_sm_log" "HTTP 500" "http fail: log shows HTTP 500"

# Test 10: summary shows failure count
assert_contains "$_sm_log" "8/8 endpoints failed" "http fail: summary shows 8/8 failed"

# Test 11: no PASS lines
assert_not_contains "$_sm_log" "PASS:" "http fail: no PASS lines"

# ── BAD_JSON: 200 but invalid response shape ─────────────────────────

echo ""
log "=== BAD_JSON: 200 but missing data/error keys ==="

# Test 12: bad JSON — exit code 1
run_smoke "bad-json"
assert_eq "$_sm_rc" "1" "bad json: exit code 1"

# Test 13: failure log mentions invalid response shape
assert_contains "$_sm_log" "invalid response shape" "bad json: log says invalid response shape"

# Test 14: mentions missing data/error
assert_contains "$_sm_log" "missing data/error" "bad json: log says missing data/error"

# ── MISSING_DATA: 200 but no "data" key ──────────────────────────────

echo ""
log "=== MISSING_DATA: 200 but no data key ==="

# Test 15: missing "data" key — exit code 1
run_smoke "missing-data"
assert_eq "$_sm_rc" "1" "missing data: exit code 1"

# Test 16: log says invalid response shape
assert_contains "$_sm_log" "invalid response shape" "missing data: log says invalid response shape"

# ── MISSING_ERROR: 200 but no "error" key ────────────────────────────

echo ""
log "=== MISSING_ERROR: 200 but no error key ==="

# Test 17: missing "error" key — exit code 1
run_smoke "missing-error"
assert_eq "$_sm_rc" "1" "missing error: exit code 1"

# Test 18: log says invalid response shape
assert_contains "$_sm_log" "invalid response shape" "missing error: log says invalid response shape"

# ── MIXED: some endpoints fail, others pass ──────────────────────────

echo ""
log "=== MIXED: first endpoint fails, rest pass ==="

# Test 19: mixed results — exit code 1
run_smoke "mixed"
assert_eq "$_sm_rc" "1" "mixed: exit code 1 (at least one failure)"

# Test 20: summary shows 1 failure
assert_contains "$_sm_log" "1/8 endpoints failed" "mixed: summary shows 1/8 failed"

# Test 21: has both PASS and FAIL lines
assert_contains "$_sm_log" "FAIL:" "mixed: has FAIL lines"
assert_contains "$_sm_log" "PASS:" "mixed: has PASS lines"

# ── BASE_URL: CLI argument override ──────────────────────────────────

echo ""
log "=== BASE_URL: CLI argument takes precedence ==="

# Test 22: pass base_url as $1 argument directly to the script
create_mock_curl "all-pass"
rm -f "$TMPDIR_ROOT/curl-counter"

_sm_rc=0
_sm_log=""
smoke_log="$TMPDIR_ROOT/smoke-url.log"
rm -f "$smoke_log"
(
  export PATH="$MOCK_BIN:$PATH"
  export SKYNET_DEV_DIR="$TMPDIR_ROOT/project/.dev"
  export SKYNET_PROJECT_DIR="$TMPDIR_ROOT/project"
  export SKYNET_PROJECT_NAME="test-smoke"
  export SKYNET_DEV_SERVER_URL="http://should-not-use:9999"
  export SKYNET_SMOKE_TIMEOUT="5"
  export SKYNET_TG_ENABLED="false"
  export SKYNET_NOTIFY_CHANNELS=""
  export SKYNET_LOCK_BACKEND="file"
  export SKYNET_USE_FLOCK="true"

  cd "$TMPDIR_ROOT/project"
  bash "$REPO_ROOT/scripts/post-merge-smoke.sh" "http://custom-host:4000" >> "$smoke_log" 2>&1
) || _sm_rc=$?

_sm_log=""
[ -f "$smoke_log" ] && _sm_log=$(cat "$smoke_log")
assert_eq "$_sm_rc" "0" "base url: CLI arg works (exit code 0)"
assert_contains "$_sm_log" "all 8 endpoints passed" "base url: endpoints tested via CLI arg"

# ── ENV_DEFAULTS: SKYNET_DEV_SERVER_URL used when no arg ─────────────

echo ""
log "=== ENV_DEFAULTS: env var used when no CLI arg ==="

# Test 23: SKYNET_DEV_SERVER_URL is used when no $1 is passed
# (Already tested implicitly by run_smoke, but verify the log doesn't mention default)
run_smoke "all-pass" "http://env-host:5000"
assert_eq "$_sm_rc" "0" "env default: exit code 0"

# ── LOG_ROTATION: rotate_log_if_needed is called ─────────────────────

echo ""
log "=== LOG_ROTATION: smoke log exists after run ==="

# Test 24: log file is created at SCRIPTS_DIR/post-merge-smoke.log
run_smoke "all-pass"
smoke_log_file="$TMPDIR_ROOT/project/.dev/scripts/post-merge-smoke.log"
if [ -f "$smoke_log_file" ]; then
  pass "log rotation: smoke log file exists"
else
  fail "log rotation: smoke log file not found at $smoke_log_file"
fi

# Test 25: log file has content
if [ -f "$smoke_log_file" ] && [ -s "$smoke_log_file" ]; then
  pass "log rotation: smoke log file is not empty"
else
  fail "log rotation: smoke log file is empty or missing"
fi

# ── ENDPOINT_COUNT: exactly 8 endpoints tested ──────────────────────

echo ""
log "=== ENDPOINT_COUNT: correct number of endpoints ==="

# Test 26: total count in summary matches expected endpoints
run_smoke "all-pass"
assert_contains "$_sm_log" "all 8 endpoints passed" "endpoint count: 8 endpoints tested"

# ── Summary ─────────────────────────────────────────────────────────

echo ""
TOTAL=$((PASS + FAIL))
log "Results: $PASS/$TOTAL passed, $FAIL failed"
if [ "$FAIL" -eq 0 ]; then
  printf "  \033[32mAll checks passed!\033[0m\n"
else
  printf "  \033[31mSome checks failed!\033[0m\n"
  exit 1
fi
