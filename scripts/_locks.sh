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

# Acquire merge lock (mkdir-based mutex).
# Writes owning PID so watchdog can proactively detect dead holders.
# Waits up to ~30s (60 retries x 0.5s). Stale lock timeout: 120s.
# Returns 0 on success, 1 on failure.
acquire_merge_lock() {
  # Emergency unlock: if the sentinel file exists, force-remove the merge lock
  # so the pipeline can recover without waiting for the 120s stale timeout.
  # Create the sentinel with: touch /tmp/skynet-{project}-unlock-emergency
  #
  # SECURITY WARNING: On shared systems, any user with write access to /tmp
  # could create this sentinel and force-release the merge lock, potentially
  # causing concurrent merges. The ownership check below mitigates this by
  # only honoring sentinels created by the current user.
  local _emergency="${SKYNET_LOCK_PREFIX}-unlock-emergency"
  if [ -f "$_emergency" ]; then
    # Only honor the emergency unlock if the file was created by the current user
    local _sentinel_owner
    _sentinel_owner="$(stat -f%u "$_emergency" 2>/dev/null || stat -c%u "$_emergency" 2>/dev/null)"
    if [ "$_sentinel_owner" = "$(id -u)" ]; then
      log "EMERGENCY UNLOCK: sentinel detected — force-removing merge lock"
      rm -rf "$MERGE_LOCK" 2>/dev/null || true
      rm -f "$_emergency"
    else
      log "EMERGENCY UNLOCK: sentinel exists but owned by UID $_sentinel_owner (expected $(id -u)) — ignoring"
    fi
  fi

  local attempts=0
  while ! mkdir "$MERGE_LOCK" 2>/dev/null; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 60 ]; then
      # Check for stale lock — first by PID liveness, then by age
      if [ -d "$MERGE_LOCK" ]; then
        local _ml_pid=""
        [ -f "$MERGE_LOCK/pid" ] && _ml_pid=$(cat "$MERGE_LOCK/pid" 2>/dev/null || echo "")
        # If PID file is missing, the holder crashed between mkdir and PID write —
        # treat as immediately stale (no live process to race with).
        if [ -z "$_ml_pid" ]; then
          rm -rf "$MERGE_LOCK" 2>/dev/null || true
          if mkdir "$MERGE_LOCK" 2>/dev/null; then
            echo $$ > "$MERGE_LOCK/pid"
            return 0
          fi
        fi
        # If PID is recorded and dead, double-check after brief sleep to
        # narrow the PID reuse race window before reclaiming.
        # Additionally verify the process command to detect PID reuse by
        # unrelated processes (a reused PID running e.g. "node" is not ours).
        if [ -n "$_ml_pid" ] && ! kill -0 "$_ml_pid" 2>/dev/null; then
          sleep 0.5  # Narrow PID reuse race window
          if ! kill -0 "$_ml_pid" 2>/dev/null; then
            # PID is still dead after delay — but verify it wasn't reused by a
            # pipeline process that already exited (rapid reuse + crash). Check
            # the command string to be safe: if a bash/skynet process now holds
            # this PID, it might have legitimately acquired the lock.
            local _cmd_check
            _cmd_check=$(ps -o comm= -p "$_ml_pid" 2>/dev/null || echo "")
            case "$_cmd_check" in
              bash*|*skynet*)
                # PID was reused by a plausible pipeline process — do NOT reclaim
                ;;
              *)
                # PID is dead or reused by unrelated process — safe to reclaim
                mv "$MERGE_LOCK" "$MERGE_LOCK.stale.$$" 2>/dev/null || true
                rm -rf "$MERGE_LOCK.stale.$$" 2>/dev/null || true
                if mkdir "$MERGE_LOCK" 2>/dev/null; then
                  echo $$ > "$MERGE_LOCK/pid"
                  return 0
                fi
                ;;
            esac
          else
            # PID came back alive (reuse race). Check if it's actually a
            # pipeline process. If the command is not bash/skynet, the PID
            # was reused by an unrelated process — treat lock as stale.
            local _cmd
            _cmd=$(ps -o comm= -p "$_ml_pid" 2>/dev/null || echo "")
            case "$_cmd" in
              bash*|*skynet*) ;; # Plausibly ours — leave lock alone
              *)
                # PID reused by unrelated process — reclaim stale lock
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
        # Fallback: check age (covers case where PID is alive but lock is ancient)
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
  # Lock acquired — write our PID
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

# Release merge lock (only if owned by this process).
release_merge_lock() {
  if [ -f "$MERGE_LOCK/pid" ] && [ "$(cat "$MERGE_LOCK/pid" 2>/dev/null)" = "$$" ]; then
    rm -rf "$MERGE_LOCK"
  fi
}
