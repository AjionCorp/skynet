#!/usr/bin/env bash
# tests/unit/lock-backend.test.sh — Unit tests for scripts/_lock_backend.sh
#
# Tests the pluggable lock backend loader: validation, sourcing, and fallback.
#
# Usage: bash tests/unit/lock-backend.test.sh

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
  case "$haystack" in
    *"$needle"*) pass "$msg" ;;
    *) fail "$msg (expected to contain '$needle', got '$haystack')" ;;
  esac
}

# ── Setup: create isolated environment ──────────────────────────────

TMPDIR_ROOT=$(mktemp -d)
cleanup() {
  rm -rf "$TMPDIR_ROOT"
}
trap cleanup EXIT

# Create a fake scripts directory with lock-backends
FAKE_SCRIPTS="$TMPDIR_ROOT/scripts"
mkdir -p "$FAKE_SCRIPTS/lock-backends"

# Create a minimal file.sh backend stub
cat > "$FAKE_SCRIPTS/lock-backends/file.sh" << 'STUB'
_TEST_LOADED_BACKEND="file"
lock_backend_acquire() { :; }
lock_backend_release() { :; }
lock_backend_check()   { :; }
STUB

# Create a custom backend stub for testing
cat > "$FAKE_SCRIPTS/lock-backends/custom.sh" << 'STUB'
_TEST_LOADED_BACKEND="custom"
lock_backend_acquire() { :; }
lock_backend_release() { :; }
lock_backend_check()   { :; }
STUB

# Create a backend with hyphens and underscores in its name
cat > "$FAKE_SCRIPTS/lock-backends/my_lock-v2.sh" << 'STUB'
_TEST_LOADED_BACKEND="my_lock-v2"
lock_backend_acquire() { :; }
lock_backend_release() { :; }
lock_backend_check()   { :; }
STUB

# Helper: source _lock_backend.sh in a subshell with given env vars
# Returns the value of _TEST_LOADED_BACKEND via stdout
run_loader() {
  local backend_name="${1:-}"
  (
    export SKYNET_SCRIPTS_DIR="$FAKE_SCRIPTS"
    if [ -n "$backend_name" ]; then
      export SKYNET_LOCK_BACKEND="$backend_name"
    else
      unset SKYNET_LOCK_BACKEND 2>/dev/null || true
    fi
    # Clear any prior loaded backend marker
    unset _TEST_LOADED_BACKEND 2>/dev/null || true
    source "$REPO_ROOT/scripts/_lock_backend.sh"
    echo "${_TEST_LOADED_BACKEND:-NONE}"
  )
}

# Helper: source _lock_backend.sh and capture stderr
run_loader_stderr() {
  local backend_name="${1:-}"
  (
    export SKYNET_SCRIPTS_DIR="$FAKE_SCRIPTS"
    if [ -n "$backend_name" ]; then
      export SKYNET_LOCK_BACKEND="$backend_name"
    else
      unset SKYNET_LOCK_BACKEND 2>/dev/null || true
    fi
    unset _TEST_LOADED_BACKEND 2>/dev/null || true
    source "$REPO_ROOT/scripts/_lock_backend.sh"
  ) 2>&1
}

# Helper: source _lock_backend.sh and capture exit code
run_loader_exit() {
  local backend_name="${1:-}"
  (
    export SKYNET_SCRIPTS_DIR="$FAKE_SCRIPTS"
    if [ -n "$backend_name" ]; then
      export SKYNET_LOCK_BACKEND="$backend_name"
    else
      unset SKYNET_LOCK_BACKEND 2>/dev/null || true
    fi
    unset _TEST_LOADED_BACKEND 2>/dev/null || true
    source "$REPO_ROOT/scripts/_lock_backend.sh"
  ) 2>/dev/null
  echo $?
}

# ── Test 1: Default backend (unset SKYNET_LOCK_BACKEND) loads file.sh ─

echo ""
log "=== Default backend: loads file.sh when SKYNET_LOCK_BACKEND is unset ==="

result=$(run_loader "")
assert_eq "$result" "file" "default backend: loads file.sh when SKYNET_LOCK_BACKEND is unset"

# ── Test 2: Explicit 'file' backend loads file.sh ─────────────────────

echo ""
log "=== Explicit 'file' backend: loads file.sh ==="

result=$(run_loader "file")
assert_eq "$result" "file" "explicit backend: SKYNET_LOCK_BACKEND=file loads file.sh"

# ── Test 3: Custom backend loads correct file ─────────────────────────

echo ""
log "=== Custom backend: loads custom.sh ==="

result=$(run_loader "custom")
assert_eq "$result" "custom" "custom backend: SKYNET_LOCK_BACKEND=custom loads custom.sh"

# ── Test 4: Backend name with hyphens and underscores ─────────────────

echo ""
log "=== Backend name with hyphens and underscores ==="

result=$(run_loader "my_lock-v2")
assert_eq "$result" "my_lock-v2" "special chars: hyphens and underscores are allowed in backend name"

# ── Test 5: Non-existent backend falls back to file with warning ──────

echo ""
log "=== Non-existent backend: falls back to file with warning ==="

result=$(run_loader "nonexistent")
assert_eq "$result" "file" "fallback: non-existent backend loads file.sh instead"

# Verify warning message is printed
stderr_output=$(run_loader_stderr "nonexistent")
assert_contains "$stderr_output" "WARNING" "fallback: prints WARNING for non-existent backend"
assert_contains "$stderr_output" "nonexistent" "fallback: warning mentions the missing backend name"
assert_contains "$stderr_output" "file" "fallback: warning mentions falling back to 'file'"

# ── Test 6: Unsafe characters in backend name cause FATAL exit ────────

echo ""
log "=== Unsafe characters: FATAL exit on invalid backend name ==="

# Test path traversal attempt
exit_code=$(run_loader_exit "../etc/passwd")
assert_eq "$exit_code" "1" "unsafe chars: '../etc/passwd' causes exit 1"

stderr_output=$(run_loader_stderr "../etc/passwd")
assert_contains "$stderr_output" "FATAL" "unsafe chars: '../etc/passwd' prints FATAL"

# Test semicolon (command injection attempt)
exit_code=$(run_loader_exit "file;rm -rf /")
assert_eq "$exit_code" "1" "unsafe chars: semicolon causes exit 1"

# Test space
exit_code=$(run_loader_exit "file backend")
assert_eq "$exit_code" "1" "unsafe chars: space causes exit 1"

# Test backtick (command substitution attempt)
exit_code=$(run_loader_exit 'file`whoami`')
assert_eq "$exit_code" "1" "unsafe chars: backtick causes exit 1"

# Test dollar sign (variable expansion attempt)
exit_code=$(run_loader_exit 'file$HOME')
assert_eq "$exit_code" "1" "unsafe chars: dollar sign causes exit 1"

# ── Test 7: Valid backend names pass validation ───────────────────────

echo ""
log "=== Valid backend names pass validation ==="

# Pure alpha
exit_code=$(run_loader_exit "file")
assert_eq "$exit_code" "0" "valid name: 'file' passes validation"

# Alphanumeric
exit_code=$(run_loader_exit "redis2")
# redis2 doesn't exist, but it should NOT fatal (just fallback)
assert_eq "$exit_code" "0" "valid name: 'redis2' passes validation (falls back, no fatal)"

# Underscores and hyphens
exit_code=$(run_loader_exit "my_lock-v2")
assert_eq "$exit_code" "0" "valid name: 'my_lock-v2' passes validation"

# ── Test 8: Empty SKYNET_LOCK_BACKEND behaves like unset ──────────────

echo ""
log "=== Empty SKYNET_LOCK_BACKEND: behaves like unset (loads file) ==="

result=$(
  export SKYNET_SCRIPTS_DIR="$FAKE_SCRIPTS"
  export SKYNET_LOCK_BACKEND=""
  unset _TEST_LOADED_BACKEND 2>/dev/null || true
  source "$REPO_ROOT/scripts/_lock_backend.sh"
  echo "${_TEST_LOADED_BACKEND:-NONE}"
)
assert_eq "$result" "file" "empty backend: SKYNET_LOCK_BACKEND='' loads file.sh"

# ── Test 9: _lock_backend_file variable is cleaned up ─────────────────

echo ""
log "=== Cleanup: _lock_backend_file is unset after sourcing ==="

# Run in a subshell to check variable state after sourcing
result=$(
  export SKYNET_SCRIPTS_DIR="$FAKE_SCRIPTS"
  unset SKYNET_LOCK_BACKEND 2>/dev/null || true
  source "$REPO_ROOT/scripts/_lock_backend.sh"
  if [ -z "${_lock_backend_file+x}" ]; then
    echo "unset"
  else
    echo "still_set"
  fi
)
assert_eq "$result" "unset" "cleanup: _lock_backend_file is unset after sourcing"

# ── Test 10: No warning when 'file' backend not found explicitly ──────

echo ""
log "=== No spurious warning when default file backend is used ==="

# When SKYNET_LOCK_BACKEND is unset and there's no custom backend to miss,
# there should be no warning even if we reach the fallback codepath
stderr_output=$(
  export SKYNET_SCRIPTS_DIR="$FAKE_SCRIPTS"
  unset SKYNET_LOCK_BACKEND 2>/dev/null || true
  source "$REPO_ROOT/scripts/_lock_backend.sh" 2>&1
)
assert_eq "$stderr_output" "" "no warning: default file backend produces no stderr"

# Also test explicit file — should produce no warning
stderr_output=$(
  export SKYNET_SCRIPTS_DIR="$FAKE_SCRIPTS"
  export SKYNET_LOCK_BACKEND="file"
  source "$REPO_ROOT/scripts/_lock_backend.sh" 2>&1
)
assert_eq "$stderr_output" "" "no warning: explicit file backend produces no stderr"

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
