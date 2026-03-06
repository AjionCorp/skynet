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
# OPS-P2-7: Increased from 180s to 600s, then OPS-P0-1 bumped to 900s.
# 600s was too close to worst-case: push timeout (120s) + typecheck + merge can
# approach 10 minutes under load. 900s gives a safe margin.
SKYNET_MERGE_LOCK_TTL="${SKYNET_MERGE_LOCK_TTL:-900}"  # 15 minutes

# P0-6: Lightweight disk space check before PID write.
# Returns 0 if disk has >10MB free, 1 otherwise.
# Uses POSIX df — no dependencies on _db.sh functions.
_lock_check_disk_space() {
  local _avail_mb
  _avail_mb=$(df -Pm . 2>/dev/null | awk 'NR==2{print $4}')
  [ -n "$_avail_mb" ] && [ "$_avail_mb" -gt 10 ] 2>/dev/null
}

# Read a PID from either a directory-based lock (lockdir/pid) or a legacy file
# lock. Returns an empty string when the lock has no readable PID yet.
read_lock_pid() {
  local lockfile="$1"
  if [ -d "$lockfile" ] && [ -f "$lockfile/pid" ]; then
    cat "$lockfile/pid" 2>/dev/null || echo ""
  elif [ -f "$lockfile" ]; then
    cat "$lockfile" 2>/dev/null || echo ""
  else
    echo ""
  fi
}

# Verify that the current lock owner still matches the expected PID before any
# cleanup removes the lock path. This prevents stale EXIT handlers from deleting
# a newly reacquired lock after a restart.
lock_is_owned_by() {
  local lockfile="$1"
  local expected_pid="${2:-$$}"
  [ -n "$expected_pid" ] || return 1
  [ "$(read_lock_pid "$lockfile")" = "$expected_pid" ]
}

release_lock_if_owned() {
  local lockfile="$1"
  local expected_pid="${2:-$$}"
  lock_is_owned_by "$lockfile" "$expected_pid" || return 1
  if [ -d "$lockfile" ]; then
    rm -rf "$lockfile"
  else
    rm -f "$lockfile"
  fi
}

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

  lock_backend_acquire "merge" "$SKYNET_MERGE_LOCK_TTL"
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
    # P0-6: Check disk space before PID write — if disk is full, the lock dir
    # exists with no PID file, blocking all workers until watchdog reclaims it.
    if ! _lock_check_disk_space; then
      rmdir "$lockfile" 2>/dev/null || true
      echo "[$(date '+%Y-%m-%d %H:%M:%S')] [${label:-}] CRITICAL: Low disk space (<10MB) — skipping lock acquisition to prevent empty lock dir." >> "${logfile:-/dev/stderr}"
      return 1
    fi
    # OPS-P0-3: Atomic PID write — write to temp file then rename so readers
    # never see a partially-written or empty PID file.
    local _tmp_pid="${lockfile}/pid.$$"
    if ! echo "$$" > "$_tmp_pid" 2>/dev/null || ! mv "$_tmp_pid" "$lockfile/pid" 2>/dev/null; then
      rm -f "$_tmp_pid" 2>/dev/null || true
      rmdir "$lockfile" 2>/dev/null || true
      echo "[$(date '+%Y-%m-%d %H:%M:%S')] [${label:-}] PID write failed (disk full?). Exiting." >> "${logfile:-/dev/stderr}"
      return 1
    fi
    return 0
  fi

  # Lock dir exists — check for stale lock (owner PID no longer running or PID reused)
  if [ -d "$lockfile" ] && [ -f "$lockfile/pid" ]; then
    local _existing_pid _lock_mtime _lock_age _stale_threshold
    _existing_pid=$(cat "$lockfile/pid" 2>/dev/null || echo "")
    # P0-3: PID reuse guard — also check lock mtime. If the PID is alive but
    # the lock is older than the stale threshold, it is likely a reused PID from
    # a dead process. Default 1800s (30m) matches high-load worst-case.
    _stale_threshold="${SKYNET_WORKER_LOCK_STALE_SECS:-1800}"
    if [ "$(uname -s)" = "Darwin" ]; then
      _lock_mtime=$(stat -f %m "$lockfile/pid" 2>/dev/null || echo 0)
    else
      _lock_mtime=$(stat -c %Y "$lockfile/pid" 2>/dev/null || echo 0)
    fi
    _lock_age=$(( $(date +%s) - _lock_mtime ))
    if [ -n "$_existing_pid" ] && kill -0 "$_existing_pid" 2>/dev/null; then
      # PID is alive — but if lock is older than threshold AND it's a huge delta, assume PID reuse.
      # However, for worker locks, we trust heartbeat/watchdog. Reclaiming a live PID's lock
      # is dangerous (leads to worktree clobbering). We only reclaim if PID is actually dead.
      echo "[$(date '+%Y-%m-%d %H:%M:%S')] [${label}] Already running (PID $_existing_pid, age ${_lock_age}s). Exiting." >> "$logfile"
      return 1
    fi
    # Stale lock (PID dead) — reclaim atomically
    mv "$lockfile" "$lockfile.stale.$$" 2>/dev/null || true
    rm -rf "$lockfile.stale.$$" 2>/dev/null || true
    if mkdir "$lockfile" 2>/dev/null; then
      # P0-6: Disk space check on stale-lock reclaim path
      if ! _lock_check_disk_space; then
        rmdir "$lockfile" 2>/dev/null || true
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] [${label:-}] CRITICAL: Low disk space (<10MB) — skipping lock acquisition to prevent empty lock dir." >> "${logfile:-/dev/stderr}"
        return 1
      fi
      # OPS-P0-3: Atomic PID write on stale-lock reclaim path
      local _tmp_pid="${lockfile}/pid.$$"
      if ! echo "$$" > "$_tmp_pid" 2>/dev/null || ! mv "$_tmp_pid" "$lockfile/pid" 2>/dev/null; then
        rm -f "$_tmp_pid" 2>/dev/null || true
        rmdir "$lockfile" 2>/dev/null || true
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] [${label:-}] PID write failed (disk full?). Exiting." >> "${logfile:-/dev/stderr}"
        return 1
      fi
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
