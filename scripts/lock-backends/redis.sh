#!/usr/bin/env bash
# lock-backends/redis.sh — Redis-based distributed lock backend
# Requires: redis-cli, SKYNET_REDIS_URL
# Uses SET NX EX for atomic lock acquisition with automatic expiry.

_REDIS_CLI="${SKYNET_REDIS_CLI:-redis-cli}"
_REDIS_URL="${SKYNET_REDIS_URL:-}"

# Validate redis is available
if [ -z "$_REDIS_URL" ] || ! command -v "$_REDIS_CLI" >/dev/null 2>&1; then
  log "WARNING: Redis lock backend requires SKYNET_REDIS_URL and redis-cli — falling back to file" 2>/dev/null || true
  # shellcheck source=/dev/null
  source "${SKYNET_SCRIPTS_DIR:-$(dirname "${BASH_SOURCE[0]}")/..}/lock-backends/file.sh"
  return 0 2>/dev/null || true
fi

_redis_cmd() { "$_REDIS_CLI" -u "$_REDIS_URL" "$@" 2>/dev/null; }

lock_backend_acquire() {
  local name="$1"
  local timeout="${2:-30}"
  local key="skynet:lock:${SKYNET_PROJECT_NAME:-default}:${name}"
  local value="$$:$(hostname -s 2>/dev/null || echo unknown)"

  local attempts=0
  local max_attempts=$(( timeout * 2 ))
  while [ "$attempts" -lt "$max_attempts" ]; do
    local result
    result=$(_redis_cmd SET "$key" "$value" EX "$timeout" NX)
    if [ "$result" = "OK" ]; then
      return 0
    fi
    attempts=$((attempts + 1))
    sleep 0.5
  done
  return 1
}

lock_backend_release() {
  local name="$1"
  local key="skynet:lock:${SKYNET_PROJECT_NAME:-default}:${name}"
  local value="$$:$(hostname -s 2>/dev/null || echo unknown)"

  # Atomic release: only delete if we own it (Lua script)
  _redis_cmd EVAL \
    "if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end" \
    1 "$key" "$value" >/dev/null || true
}

lock_backend_check() {
  local name="$1"
  local key="skynet:lock:${SKYNET_PROJECT_NAME:-default}:${name}"
  local value="$$:$(hostname -s 2>/dev/null || echo unknown)"

  local current
  current=$(_redis_cmd GET "$key")
  [ "$current" = "$value" ]
}
