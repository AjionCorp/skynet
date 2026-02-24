#!/usr/bin/env bash
# lock-backends/redis.sh — Redis-based distributed lock backend
# Requires: redis-cli, SKYNET_REDIS_URL
# Uses SET NX EX for atomic lock acquisition with automatic expiry.
#
# TLS: For production deployments, use a rediss:// URL in SKYNET_REDIS_URL
# (e.g. rediss://host:6380) and ensure redis-cli is built with TLS support.
# redis-cli 6.0+ supports --tls natively. For older versions, use stunnel.

_REDIS_CLI="${SKYNET_REDIS_CLI:-redis-cli}"
_REDIS_URL="${SKYNET_REDIS_URL:-}"

# Validate redis is available
if [ -z "$_REDIS_URL" ]; then
  echo "ERROR: SKYNET_LOCK_BACKEND=redis requires SKYNET_REDIS_URL to be set. Falling back to file backend." >&2
  # shellcheck source=/dev/null
  source "${SKYNET_SCRIPTS_DIR:-$(dirname "${BASH_SOURCE[0]}")/..}/lock-backends/file.sh"
  return 0 2>/dev/null || true
fi
if ! command -v "$_REDIS_CLI" >/dev/null 2>&1; then
  echo "ERROR: SKYNET_LOCK_BACKEND=redis requires '$_REDIS_CLI' in PATH. Falling back to file backend." >&2
  # shellcheck source=/dev/null
  source "${SKYNET_SCRIPTS_DIR:-$(dirname "${BASH_SOURCE[0]}")/..}/lock-backends/file.sh"
  return 0 2>/dev/null || true
fi

_redis_cmd() { "$_REDIS_CLI" -u "$_REDIS_URL" "$@" 2>/dev/null; }

# Compute lock owner identity once at source time to ensure consistent
# value across acquire/release/extend/check calls. Re-computing on each
# call risks hostname changes causing release to fail to match.
_REDIS_LOCK_VALUE="$$:$(hostname -s 2>/dev/null || echo unknown)"
_REDIS_LOCK_VALUE=$(printf '%.128s' "$_REDIS_LOCK_VALUE")

lock_backend_acquire() {
  local name="$1"
  local timeout="${2:-30}"
  local key="skynet:lock:${SKYNET_PROJECT_NAME:-default}:${name}"
  local value="$_REDIS_LOCK_VALUE"

  local attempts=0
  local max_attempts=$(( timeout * 2 ))
  while [ "$attempts" -lt "$max_attempts" ]; do
    local result
    result=$(_redis_cmd SET "$key" "$value" EX "$timeout" NX)
    if [ "$result" = "OK" ]; then
      return 0
    fi
    attempts=$((attempts + 1))
    # NOTE: sleep 0.5 is non-POSIX but supported on Linux (coreutils) and macOS.
    # On strict POSIX systems, replace with `sleep 1` or `perl -e 'select(undef,undef,undef,0.5)'`.
    sleep 0.5
  done
  return 1
}

lock_backend_release() {
  local name="$1"
  local key="skynet:lock:${SKYNET_PROJECT_NAME:-default}:${name}"
  local value="$_REDIS_LOCK_VALUE"

  # Atomic release: only delete if we own it (Lua script)
  _redis_cmd EVAL \
    "if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end" \
    1 "$key" "$value" >/dev/null || true
}

lock_backend_extend() {
  local name="$1"
  local timeout="${2:-30}"
  local key="skynet:lock:${SKYNET_PROJECT_NAME:-default}:${name}"
  local value="$_REDIS_LOCK_VALUE"
  # Only extend if we still own the lock (atomic check + extend via Lua)
  _redis_cmd EVAL \
    "if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('expire',KEYS[1],ARGV[2]) else return 0 end" \
    1 "$key" "$value" "$timeout" >/dev/null || return 1
}

lock_backend_check() {
  local name="$1"
  local key="skynet:lock:${SKYNET_PROJECT_NAME:-default}:${name}"
  local value="$_REDIS_LOCK_VALUE"

  local current
  current=$(_redis_cmd GET "$key")
  [ "$current" = "$value" ]
}

lock_backend_health_check() {
  local result
  result=$("${SKYNET_REDIS_CLI:-redis-cli}" -u "$SKYNET_REDIS_URL" PING 2>/dev/null)
  [ "$result" = "PONG" ]
}
