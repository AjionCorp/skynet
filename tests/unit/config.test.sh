#!/usr/bin/env bash
# config.test.sh — Unit tests for _config.sh utility functions
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

PASS=0; FAIL=0; ERRORS=""
assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    ERRORS="${ERRORS}\n  FAIL: $desc\n    expected: $expected\n    actual:   $actual"
  fi
}

# Source config to get utility functions
# We need a minimal config to source _config.sh
export SKYNET_DEV_DIR="$(mktemp -d)"
mkdir -p "$SKYNET_DEV_DIR"
cat > "$SKYNET_DEV_DIR/skynet.config.sh" << CONF
export SKYNET_PROJECT_NAME="test-project"
export SKYNET_PROJECT_DIR="/tmp/test-project"
export SKYNET_DEV_DIR="$SKYNET_DEV_DIR"
CONF

# Source config (will set up all derived variables)
source scripts/_config.sh 2>/dev/null || true

# Test rotate_log_if_needed function exists
assert_eq "rotate_log_if_needed is defined" "0" "$(type -t rotate_log_if_needed >/dev/null 2>&1 && echo 0 || echo 1)"

# Test _json_escape if it exists (from structured logging)
if type -t _json_escape >/dev/null 2>&1; then
  assert_eq "_json_escape quotes" 'hello\"world' "$(_json_escape 'hello"world')"
  assert_eq "_json_escape newline" 'hello\nworld' "$(_json_escape "$(printf 'hello\nworld')")"
fi

# Test emit_event function
assert_eq "emit_event is defined" "0" "$(type -t emit_event >/dev/null 2>&1 && echo 0 || echo 1)"

# Test file_mtime function
assert_eq "file_mtime is defined" "0" "$(type -t file_mtime >/dev/null 2>&1 && echo 0 || echo 1)"

# Test file_size function
assert_eq "file_size is defined" "0" "$(type -t file_size >/dev/null 2>&1 && echo 0 || echo 1)"

# Test _log function
assert_eq "_log is defined" "0" "$(type -t _log >/dev/null 2>&1 && echo 0 || echo 1)"

# Test _generate_trace_id function
assert_eq "_generate_trace_id is defined" "0" "$(type -t _generate_trace_id >/dev/null 2>&1 && echo 0 || echo 1)"

# Cleanup
rm -rf "$SKYNET_DEV_DIR"

echo ""
echo "config.test.sh: $PASS passed, $FAIL failed"
if [ -n "$ERRORS" ]; then
  printf "$ERRORS\n"
fi
exit $FAIL
