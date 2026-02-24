#!/usr/bin/env bash
# lock-backends/file.sh — File-based lock backend (flock + mkdir fallback)
# Default backend. Uses kernel-level flock when available,
# falls back to mkdir-based atomic locks.

lock_backend_acquire() {
  local name="$1"
  local timeout="${2:-30}"
  local flockfile="${SKYNET_LOCK_PREFIX}-${name}.flock"
  local lockdir="${SKYNET_LOCK_PREFIX}-${name}.lock"

  if [ "${SKYNET_USE_FLOCK:-true}" = "true" ] && { command -v flock >/dev/null 2>&1 || command -v perl >/dev/null 2>&1; }; then
    _acquire_file_lock "$flockfile" "$timeout"
    return $?
  fi

  # Fallback: mkdir-based lock
  local attempts=0
  local max_attempts=$(( timeout * 2 ))
  while ! mkdir "$lockdir" 2>/dev/null; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge "$max_attempts" ]; then
      # Check for stale lock
      if [ -d "$lockdir" ] && [ -f "$lockdir/pid" ]; then
        local _pid
        _pid=$(cat "$lockdir/pid" 2>/dev/null || echo "")
        if [ -n "$_pid" ] && ! kill -0 "$_pid" 2>/dev/null; then
          rm -rf "$lockdir" 2>/dev/null || true
          if mkdir "$lockdir" 2>/dev/null; then
            echo $$ > "$lockdir/pid"
            return 0
          fi
        fi
      fi
      return 1
    fi
    sleep 0.5
  done
  echo $$ > "$lockdir/pid"
  return 0
}

lock_backend_release() {
  local name="$1"
  local lockdir="${SKYNET_LOCK_PREFIX}-${name}.lock"

  if [ "${SKYNET_USE_FLOCK:-true}" = "true" ] && [ -n "${_FLOCK_FILE:-}" ]; then
    _release_file_lock
    return
  fi

  # Legacy mkdir release
  if [ -f "$lockdir/pid" ] && [ "$(cat "$lockdir/pid" 2>/dev/null)" = "$$" ]; then
    rm -rf "$lockdir"
  fi
}

lock_backend_check() {
  local name="$1"
  local flockfile="${SKYNET_LOCK_PREFIX}-${name}.flock"
  local lockdir="${SKYNET_LOCK_PREFIX}-${name}.lock"

  if [ "${SKYNET_USE_FLOCK:-true}" = "true" ]; then
    [ -f "${flockfile}.owner" ] && [ "$(cat "${flockfile}.owner" 2>/dev/null)" = "$$" ]
    return $?
  fi

  [ -d "$lockdir" ] && [ -f "$lockdir/pid" ] && [ "$(cat "$lockdir/pid" 2>/dev/null)" = "$$" ]
  return $?
}
