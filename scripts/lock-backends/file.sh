#!/usr/bin/env bash
# lock-backends/file.sh — File-based lock backend (flock + mkdir fallback)
# Default backend. Uses kernel-level flock when available,
# falls back to mkdir-based atomic locks.

lock_backend_acquire() {
  local name="$1"
  local timeout="${2:-30}"
  local flockfile="${SKYNET_LOCK_PREFIX}-${name}.flock"
  local lockdir="${SKYNET_LOCK_PREFIX}-${name}.lock"
  local lock_ttl="${timeout:-}"
  local missing_pid_grace="${SKYNET_LOCK_MISSING_PID_GRACE_SECS:-5}"

  case "$lock_ttl" in
    ''|*[!0-9]*)
      lock_ttl="${SKYNET_LOCK_TTL_SECS:-600}"  # 10 minutes default
      ;;
  esac
  case "$missing_pid_grace" in
    ''|*[!0-9]*)
      missing_pid_grace=5
      ;;
  esac

  if [ "${SKYNET_USE_FLOCK:-true}" = "true" ] && { command -v flock >/dev/null 2>&1 || command -v perl >/dev/null 2>&1; }; then
    _acquire_file_lock "$flockfile" "$timeout"
    local _flock_rc=$?
    if [ "$_flock_rc" -eq 0 ]; then
      # Also create mkdir lockdir with PID for observability (ps/ls can see who holds the lock)
      mkdir "$lockdir" 2>/dev/null || true
      echo "$$" > "$lockdir/pid" 2>/dev/null || true
    fi
    return $_flock_rc
  fi

  # Fallback: mkdir-based lock
  local attempts=0
  local max_attempts=$(( timeout * 2 ))
  while ! mkdir "$lockdir" 2>/dev/null; do
    # Check for stale lock. Never reclaim a lock owned by a live PID based on
    # age alone: long merges/typechecks/pushes are valid and must remain single-holder.
    if [ -d "$lockdir" ]; then
      local _pid=""
      [ -f "$lockdir/pid" ] && _pid=$(cat "$lockdir/pid" 2>/dev/null || echo "")

      local _force_release=false

      # Case 1: PID file exists and holder is dead
      if [ -n "$_pid" ] && ! kill -0 "$_pid" 2>/dev/null; then
        _force_release=true
      fi

      # Case 2: Missing/empty PID long enough to be considered stale.
      # This covers crashes between mkdir and PID write without racing a live
      # process that has not finished writing its PID yet.
      if ! $_force_release && { [ ! -f "$lockdir/pid" ] || [ -z "$_pid" ]; }; then
        local _lock_age=0
        local _lock_mtime
        local _lock_age_threshold="$missing_pid_grace"
        if [ "$lock_ttl" -lt "$_lock_age_threshold" ]; then
          _lock_age_threshold="$lock_ttl"
        fi
        if [ "$_lock_age_threshold" -lt 1 ]; then
          _lock_age_threshold=1
        fi
        if [ "$(uname -s)" = "Darwin" ]; then
          _lock_mtime=$(stat -f %m "$lockdir" 2>/dev/null || echo 0)
        else
          _lock_mtime=$(stat -c %Y "$lockdir" 2>/dev/null || echo 0)
        fi
        _lock_age=$(( $(date +%s) - _lock_mtime ))
        if [ "$_lock_age" -gt "$_lock_age_threshold" ]; then
          _force_release=true
          if declare -f log >/dev/null 2>&1; then
            log "WARNING: Force-releasing stale $name lock with missing PID (age=${_lock_age}s > grace=${_lock_age_threshold}s)"
          fi
        fi
      fi

      if $_force_release; then
        rm -rf "$lockdir" 2>/dev/null || true
        if mkdir "$lockdir" 2>/dev/null; then
          if ! echo "$$" > "$lockdir/pid" 2>/dev/null; then
            rmdir "$lockdir" 2>/dev/null || true
            return 1
          fi
          return 0
        fi
      fi
    fi

    attempts=$((attempts + 1))
    if [ "$attempts" -ge "$max_attempts" ]; then
      return 1
    fi
    # NOTE: sleep 0.5 is non-POSIX but supported on Linux (coreutils) and macOS.
    # On strict POSIX systems, replace with `sleep 1` or `perl -e 'select(undef,undef,undef,0.5)'`.
    sleep 0.5
  done
  if ! echo "$$" > "$lockdir/pid" 2>/dev/null; then
    rmdir "$lockdir" 2>/dev/null || true
    return 1
  fi
  return 0
}

lock_backend_release() {
  local name="$1"
  local lockdir="${SKYNET_LOCK_PREFIX}-${name}.lock"

  if [ "${SKYNET_USE_FLOCK:-true}" = "true" ] && [ -n "${_FLOCK_FILE:-}" ]; then
    _release_file_lock
    # Also clean up mkdir lockdir if it exists and we own it
    if [ -f "$lockdir/pid" ] && [ "$(cat "$lockdir/pid" 2>/dev/null)" = "$$" ]; then
      rm -rf "$lockdir" 2>/dev/null || true
    fi
    return
  fi

  # Legacy mkdir release
  if [ -f "$lockdir/pid" ] && [ "$(cat "$lockdir/pid" 2>/dev/null)" = "$$" ]; then
    rm -rf "$lockdir"
  fi
}

# OPS-P2-7: Touch the PID file on extend so watchdog freshness detection sees recent mtime
lock_backend_extend() {
  local name="$1"
  local lockdir="${SKYNET_LOCK_PREFIX}-${name}.lock"
  if [ -f "$lockdir/pid" ] && [ "$(cat "$lockdir/pid" 2>/dev/null)" = "$$" ]; then
    touch "$lockdir/pid" 2>/dev/null || true
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
