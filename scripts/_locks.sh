#!/usr/bin/env bash
# _locks.sh — Shared lock helpers for cross-worker coordination
# Sourced by _config.sh. Requires SKYNET_LOCK_PREFIX to be set.
#
# NOTE: SIGKILL (kill -9) cannot be caught by any process, so EXIT/TERM traps
# will NOT fire in that case. This means lock directories may be left behind
# ("stale locks"). The watchdog's crash_recovery() handles this by checking
# whether the PID recorded in the lock is still alive, reclaiming stale locks
# from dead processes.

MERGE_LOCK="${SKYNET_LOCK_PREFIX}-merge.lock"
MERGE_FLOCK="${SKYNET_LOCK_PREFIX}-merge.flock"
SKYNET_USE_FLOCK="${SKYNET_USE_FLOCK:-true}"

# Acquire merge lock.
# Primary: kernel-level flock(2) via _acquire_file_lock (auto-releases on death).
# Fallback: legacy mkdir-based mutex when SKYNET_USE_FLOCK=false.
# Returns 0 on success, 1 on failure.
acquire_merge_lock() {
  # Emergency unlock sentinel (keep existing logic)
  local _emergency="${SKYNET_LOCK_PREFIX}-unlock-emergency"
  if [ -f "$_emergency" ]; then
    local _sentinel_owner
    _sentinel_owner="$(stat -f%u "$_emergency" 2>/dev/null || stat -c%u "$_emergency" 2>/dev/null)"
    if [ "$_sentinel_owner" = "$(id -u)" ]; then
      log "EMERGENCY UNLOCK: sentinel detected — force-removing merge lock"
      rm -rf "$MERGE_LOCK" 2>/dev/null || true
      rm -f "$MERGE_FLOCK" "$MERGE_FLOCK.owner" 2>/dev/null || true
      rm -f "$_emergency"
    else
      log "EMERGENCY UNLOCK: sentinel exists but owned by UID $_sentinel_owner (expected $(id -u)) — ignoring"
    fi
  fi

  if [ "$SKYNET_USE_FLOCK" = "true" ] && { command -v flock >/dev/null 2>&1 || command -v perl >/dev/null 2>&1; }; then
    # New: kernel-level flock — auto-releases on process death
    _acquire_file_lock "$MERGE_FLOCK" 30
    return $?
  fi

  # Fallback: legacy mkdir-based lock (original implementation)
  local attempts=0
  while ! mkdir "$MERGE_LOCK" 2>/dev/null; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 60 ]; then
      if [ -d "$MERGE_LOCK" ]; then
        local _ml_pid=""
        [ -f "$MERGE_LOCK/pid" ] && _ml_pid=$(cat "$MERGE_LOCK/pid" 2>/dev/null || echo "")
        if [ -z "$_ml_pid" ]; then
          rm -rf "$MERGE_LOCK" 2>/dev/null || true
          if mkdir "$MERGE_LOCK" 2>/dev/null; then
            echo $$ > "$MERGE_LOCK/pid"
            return 0
          fi
        fi
        if [ -n "$_ml_pid" ] && ! kill -0 "$_ml_pid" 2>/dev/null; then
          sleep 0.5
          if ! kill -0 "$_ml_pid" 2>/dev/null; then
            local _cmd_check
            _cmd_check=$(ps -o comm= -p "$_ml_pid" 2>/dev/null || echo "")
            case "$_cmd_check" in
              bash*|*skynet*) ;;
              *)
                mv "$MERGE_LOCK" "$MERGE_LOCK.stale.$$" 2>/dev/null || true
                rm -rf "$MERGE_LOCK.stale.$$" 2>/dev/null || true
                if mkdir "$MERGE_LOCK" 2>/dev/null; then
                  echo $$ > "$MERGE_LOCK/pid"
                  return 0
                fi
                ;;
            esac
          fi
        fi
        local lock_mtime
        lock_mtime=$(file_mtime "$MERGE_LOCK")
        local lock_age=$(( $(date +%s) - lock_mtime ))
        if [ "$lock_age" -gt 120 ]; then
          rm -rf "$MERGE_LOCK" 2>/dev/null || true
          if mkdir "$MERGE_LOCK" 2>/dev/null; then
            echo $$ > "$MERGE_LOCK/pid"
            return 0
          fi
        fi
      fi
      return 1
    fi
    sleep 0.5
  done
  echo $$ > "$MERGE_LOCK/pid"
  return 0
}

# Acquire a worker/fixer PID lock (mkdir-based mutex).
# Handles stale lock detection (dead PID) and atomic reclaim.
# Usage: acquire_worker_lock "$LOCKFILE" "$LOG" "$LABEL"
#   LOCKFILE — path to the lock directory
#   LOG      — log file for messages
#   LABEL    — short prefix for log lines (e.g. "W1", "F2")
# Returns 0 on success, 1 on contention (caller should exit).
acquire_worker_lock() {
  local lockfile="$1"
  local logfile="$2"
  local label="$3"

  if mkdir "$lockfile" 2>/dev/null; then
    echo $$ > "$lockfile/pid"
    return 0
  fi

  # Lock dir exists — check for stale lock (owner PID no longer running)
  if [ -d "$lockfile" ] && [ -f "$lockfile/pid" ]; then
    local _existing_pid
    _existing_pid=$(cat "$lockfile/pid" 2>/dev/null || echo "")
    if [ -n "$_existing_pid" ] && kill -0 "$_existing_pid" 2>/dev/null; then
      echo "[$(date '+%Y-%m-%d %H:%M:%S')] [${label}] Already running (PID $_existing_pid). Exiting." >> "$logfile"
      return 1
    fi
    # Stale lock — reclaim atomically
    mv "$lockfile" "$lockfile.stale.$$" 2>/dev/null || true
    rm -rf "$lockfile.stale.$$" 2>/dev/null || true
    if mkdir "$lockfile" 2>/dev/null; then
      echo $$ > "$lockfile/pid"
      return 0
    else
      echo "[$(date '+%Y-%m-%d %H:%M:%S')] [${label}] Lock contention. Exiting." >> "$logfile"
      return 1
    fi
  else
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] [${label}] Lock contention. Exiting." >> "$logfile"
    return 1
  fi
}

# Release merge lock (flock or legacy mkdir, depending on mode).
release_merge_lock() {
  if [ "$SKYNET_USE_FLOCK" = "true" ] && [ -n "$_FLOCK_FILE" ]; then
    _release_file_lock
    return
  fi
  # Legacy mkdir-based release
  if [ -f "$MERGE_LOCK/pid" ] && [ "$(cat "$MERGE_LOCK/pid" 2>/dev/null)" = "$$" ]; then
    rm -rf "$MERGE_LOCK"
  fi
}
