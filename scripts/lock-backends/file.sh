#!/usr/bin/env bash
# lock-backends/file.sh — File-based lock backend (flock + mkdir fallback)
# Default backend. Uses kernel-level flock when available,
# falls back to mkdir-based atomic locks.

lock_backend_acquire() {
  local name="$1"
  local timeout="${2:-30}"
  local flockfile="${SKYNET_LOCK_PREFIX}-${name}.flock"
  local lockdir="${SKYNET_LOCK_PREFIX}-${name}.lock"
  local lock_ttl="${SKYNET_LOCK_TTL_SECS:-600}"  # 10 minutes default

  if [ "${SKYNET_USE_FLOCK:-true}" = "true" ] && { command -v flock >/dev/null 2>&1 || command -v perl >/dev/null 2>&1; }; then
    _acquire_file_lock "$flockfile" "$timeout"
    return $?
  fi

  # Fallback: mkdir-based lock
  local attempts=0
  local max_attempts=$(( timeout * 2 ))
  while ! mkdir "$lockdir" 2>/dev/null; do
    # Check for stale lock: holder PID is dead OR lock is older than TTL
    if [ -d "$lockdir" ]; then
      local _pid=""
      [ -f "$lockdir/pid" ] && _pid=$(cat "$lockdir/pid" 2>/dev/null || echo "")

      local _force_release=false

      # Case 1: PID file exists and holder is dead
      if [ -n "$_pid" ] && ! kill -0 "$_pid" 2>/dev/null; then
        _force_release=true
      fi

      # Case 2: Lock age exceeds TTL (dead worker that left no PID, or stuck process)
      if ! $_force_release && [ -f "$lockdir/pid" ]; then
        local _lock_age=0
        local _lock_mtime
        if [ "$(uname -s)" = "Darwin" ]; then
          _lock_mtime=$(stat -f %m "$lockdir/pid" 2>/dev/null || echo 0)
        else
          _lock_mtime=$(stat -c %Y "$lockdir/pid" 2>/dev/null || echo 0)
        fi
        _lock_age=$(( $(date +%s) - _lock_mtime ))
        if [ "$_lock_age" -gt "$lock_ttl" ]; then
          _force_release=true
          if declare -f log >/dev/null 2>&1; then
            log "WARNING: Force-releasing stale $name lock (age=${_lock_age}s > TTL=${lock_ttl}s, holder PID=${_pid:-unknown})"
          fi
        fi
      fi

      # Case 3: No PID file at all (crash between mkdir and PID write)
      if ! $_force_release && [ ! -f "$lockdir/pid" ]; then
        _force_release=true
      fi

      if $_force_release; then
        rm -rf "$lockdir" 2>/dev/null || true
        if mkdir "$lockdir" 2>/dev/null; then
          echo $$ > "$lockdir/pid"
          return 0
        fi
      fi
    fi

    attempts=$((attempts + 1))
    if [ "$attempts" -ge "$max_attempts" ]; then
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

lock_backend_extend() { :; }  # flock doesn't expire — no-op

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
