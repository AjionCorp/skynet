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

# Auto-TTL: maximum age (seconds) for a merge lock before force-release.
# Prevents pipeline deadlock when a worker dies while holding the merge lock.
SKYNET_MERGE_LOCK_TTL="${SKYNET_MERGE_LOCK_TTL:-180}"  # 3 minutes

# Acquire merge lock.
# Delegates to the pluggable lock backend (file/redis).
# Before delegating, checks for stale merge locks older than the TTL
# whose holder PID is dead, and force-releases them.
# Returns 0 on success, 1 on failure.
acquire_merge_lock() {
  # Emergency unlock sentinel
  local _emergency="${SKYNET_LOCK_PREFIX}-unlock-emergency"
  if [ -f "$_emergency" ]; then
    local _sentinel_owner
    _sentinel_owner="$(stat -f%u "$_emergency" 2>/dev/null || stat -c%u "$_emergency" 2>/dev/null)"
    if [ "$_sentinel_owner" = "$(id -u)" ]; then
      log "EMERGENCY UNLOCK: sentinel detected — force-removing merge lock"
      lock_backend_release "merge" 2>/dev/null || true
      rm -rf "$MERGE_LOCK" 2>/dev/null || true
      rm -f "$MERGE_FLOCK" "$MERGE_FLOCK.owner" 2>/dev/null || true
      rm -f "$_emergency"
    else
      log "EMERGENCY UNLOCK: sentinel exists but owned by UID $_sentinel_owner (expected $(id -u)) — ignoring"
    fi
  fi

  # Auto-TTL: force-release stale merge lock if holder PID is dead AND age > TTL.
  # This covers the mkdir-based fallback path; flock releases automatically on
  # process death, so only the legacy path needs this safety net.
  if [ -d "$MERGE_LOCK" ] && [ -f "$MERGE_LOCK/pid" ]; then
    local _ml_pid _ml_age _ml_mtime
    _ml_pid=$(cat "$MERGE_LOCK/pid" 2>/dev/null || echo "")
    if [ "$(uname -s)" = "Darwin" ]; then
      _ml_mtime=$(stat -f %m "$MERGE_LOCK/pid" 2>/dev/null || echo 0)
    else
      _ml_mtime=$(stat -c %Y "$MERGE_LOCK/pid" 2>/dev/null || echo 0)
    fi
    _ml_age=$(( $(date +%s) - _ml_mtime ))

    if [ "$_ml_age" -gt "$SKYNET_MERGE_LOCK_TTL" ] && { [ -z "$_ml_pid" ] || ! kill -0 "$_ml_pid" 2>/dev/null; }; then
      log "WARNING: Force-releasing stale merge lock (age=${_ml_age}s > TTL=${SKYNET_MERGE_LOCK_TTL}s, holder PID=${_ml_pid:-unknown})"
      rm -rf "$MERGE_LOCK" 2>/dev/null || true
    fi
  fi

  lock_backend_acquire "merge" 30
  return $?
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

# Extend merge lock TTL (prevents expiry during long operations).
# No-op for file backend (flock doesn't expire); extends Redis key TTL.
extend_merge_lock() {
  lock_backend_extend "merge" 30
}

# Release merge lock (delegates to pluggable backend).
release_merge_lock() {
  lock_backend_release "merge"
}
