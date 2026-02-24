#!/usr/bin/env bash
# tests/unit/redis-lock.test.sh — Unit tests for scripts/lock-backends/redis.sh
#
# Tests the Redis distributed lock backend interface using a mocked redis-cli.
# Since redis-cli may not be available in CI, we inject a mock shell function
# before sourcing redis.sh.
#
# Usage: bash tests/unit/redis-lock.test.sh

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

# ── Setup: create isolated environment ──────────────────────────────

TMPDIR_ROOT=$(mktemp -d)
ORIG_PATH="$PATH"
cleanup() {
  rm -rf "$TMPDIR_ROOT"
  export PATH="$ORIG_PATH"
}
trap cleanup EXIT

# Minimal config stubs
export SKYNET_PROJECT_NAME="test-redis"
export SKYNET_SCRIPTS_DIR="$REPO_ROOT/scripts"

# Create a mock redis-cli script in a temp bin directory.
# The mock uses a state file to simulate Redis SET NX, GET, DEL, EVAL behavior.
MOCK_BIN="$TMPDIR_ROOT/mock-bin"
REDIS_STATE_DIR="$TMPDIR_ROOT/redis-state"
mkdir -p "$MOCK_BIN" "$REDIS_STATE_DIR"

cat > "$MOCK_BIN/redis-cli" <<'MOCK_REDIS'
#!/usr/bin/env bash
# Mock redis-cli — uses files in REDIS_STATE_DIR to simulate key-value store.
# Supports: SET key value EX ttl NX, GET key, DEL key, EVAL script 1 key value [extra]

REDIS_STATE_DIR="${REDIS_STATE_DIR:?}"
# Skip -u <url> if present
shift 2  # skip -u and the URL

cmd="$1"; shift

case "$cmd" in
  SET)
    key="$1"; value="$2"
    # Parse flags: EX <ttl> NX
    shift 2
    nx=false
    while [ $# -gt 0 ]; do
      case "$1" in
        EX) shift ;; # skip ttl value
        NX) nx=true ;;
      esac
      shift
    done
    key_file="$REDIS_STATE_DIR/$(echo "$key" | tr '/:' '__')"
    if $nx && [ -f "$key_file" ]; then
      echo ""  # nil — key already exists
      exit 0
    fi
    echo "$value" > "$key_file"
    echo "OK"
    ;;
  GET)
    key="$1"
    key_file="$REDIS_STATE_DIR/$(echo "$key" | tr '/:' '__')"
    if [ -f "$key_file" ]; then
      cat "$key_file"
    else
      echo ""
    fi
    ;;
  DEL)
    key="$1"
    key_file="$REDIS_STATE_DIR/$(echo "$key" | tr '/:' '__')"
    rm -f "$key_file"
    echo "1"
    ;;
  EVAL)
    # Minimal Lua script emulation for the two patterns used in redis.sh:
    # Release: if get(key)==value then del(key) else return 0
    # Extend:  if get(key)==value then expire(key,ttl) else return 0
    script="$1"; shift
    num_keys="$1"; shift
    key="$1"; shift
    value="$1"; shift
    extra="${1:-}"

    key_file="$REDIS_STATE_DIR/$(echo "$key" | tr '/:' '__')"
    current=""
    [ -f "$key_file" ] && current=$(cat "$key_file")

    if echo "$script" | grep -q "del"; then
      # Release pattern
      if [ "$current" = "$value" ]; then
        rm -f "$key_file"
        echo "1"
      else
        echo "0"
      fi
    elif echo "$script" | grep -q "expire"; then
      # Extend pattern
      if [ "$current" = "$value" ]; then
        echo "1"
      else
        echo "0"
      fi
    else
      echo "0"
    fi
    ;;
  *)
    echo "ERR unknown command '$cmd'"
    exit 1
    ;;
esac
MOCK_REDIS
chmod +x "$MOCK_BIN/redis-cli"

# Export state dir for the mock
export REDIS_STATE_DIR
export PATH="$MOCK_BIN:$ORIG_PATH"

# Set required env vars for redis.sh
export SKYNET_REDIS_URL="redis://mock:6379"
export SKYNET_REDIS_CLI="redis-cli"

# Source the redis lock backend
source "$REPO_ROOT/scripts/lock-backends/redis.sh"

# ── Test: lock_backend_acquire succeeds when redis returns OK ────────

echo ""
log "=== lock_backend_acquire: success ==="

# Clear any prior state
rm -f "$REDIS_STATE_DIR"/*

if lock_backend_acquire "test-lock-1" 5; then
  pass "lock_backend_acquire: succeeds when lock is free"
else
  fail "lock_backend_acquire: should succeed when lock is free"
fi

# ── Test: lock_backend_acquire fails on timeout when lock is held ────

echo ""
log "=== lock_backend_acquire: timeout on held lock ==="

# Pre-set the lock key with a different owner value
key_file="$REDIS_STATE_DIR/$(echo "skynet:lock:test-redis:test-lock-2" | tr '/:' '__')"
echo "99999:otherhost" > "$key_file"

# Acquire with a very short timeout (1 second — will do 2 attempts)
if lock_backend_acquire "test-lock-2" 1 2>/dev/null; then
  fail "lock_backend_acquire: should fail when lock is already held"
else
  pass "lock_backend_acquire: fails on timeout when lock is held by another"
fi

# ── Test: lock_backend_release only releases when we own the lock ────

echo ""
log "=== lock_backend_release: ownership check ==="

# Clear state and acquire a lock
rm -f "$REDIS_STATE_DIR"/*
lock_backend_acquire "test-lock-3" 5

# Verify key exists
key_file="$REDIS_STATE_DIR/$(echo "skynet:lock:test-redis:test-lock-3" | tr '/:' '__')"
if [ -f "$key_file" ]; then
  pass "lock_backend_release: lock key exists before release"
else
  fail "lock_backend_release: lock key should exist before release"
fi

# Release the lock (should succeed since we own it)
lock_backend_release "test-lock-3"

# After release, key file should be removed
if [ -f "$key_file" ]; then
  fail "lock_backend_release: lock key should be removed after release"
else
  pass "lock_backend_release: lock key removed after owner releases"
fi

# Test that release by non-owner leaves key intact
rm -f "$REDIS_STATE_DIR"/*
echo "99999:otherhost" > "$key_file"

lock_backend_release "test-lock-3"

# Key should still exist (we didn't own it)
if [ -f "$key_file" ]; then
  pass "lock_backend_release: non-owner release leaves key intact"
else
  fail "lock_backend_release: non-owner release should not remove key"
fi

# ── Test: lock_backend_check returns 0 when we own, 1 when not ──────

echo ""
log "=== lock_backend_check: ownership ==="

# Clear state and acquire a lock
rm -f "$REDIS_STATE_DIR"/*
lock_backend_acquire "test-lock-4" 5

if lock_backend_check "test-lock-4"; then
  pass "lock_backend_check: returns 0 when we own the lock"
else
  fail "lock_backend_check: should return 0 when we own the lock"
fi

# Overwrite key with different owner
key_file="$REDIS_STATE_DIR/$(echo "skynet:lock:test-redis:test-lock-4" | tr '/:' '__')"
echo "99999:otherhost" > "$key_file"

if lock_backend_check "test-lock-4"; then
  fail "lock_backend_check: should return 1 when another process owns the lock"
else
  pass "lock_backend_check: returns 1 when we don't own the lock"
fi

# Test non-existent lock
rm -f "$REDIS_STATE_DIR"/*
if lock_backend_check "test-lock-nonexistent"; then
  fail "lock_backend_check: should return 1 when lock doesn't exist"
else
  pass "lock_backend_check: returns 1 when lock doesn't exist"
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
