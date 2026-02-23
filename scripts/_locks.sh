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
        if [ -n "$_ml_pid" ] && ! kill -0 "$_ml_pid" 2>/dev/null; then
          sleep 0.5  # Narrow PID reuse race window
          if ! kill -0 "$_ml_pid" 2>/dev/null; then
            mv "$MERGE_LOCK" "$MERGE_LOCK.stale.$$" 2>/dev/null || true
            rm -rf "$MERGE_LOCK.stale.$$" &
            if mkdir "$MERGE_LOCK" 2>/dev/null; then
              echo $$ > "$MERGE_LOCK/pid"
              return 0
            fi
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

# Release merge lock (only if owned by this process).
release_merge_lock() {
  if [ -f "$MERGE_LOCK/pid" ] && [ "$(cat "$MERGE_LOCK/pid" 2>/dev/null)" = "$$" ]; then
    rm -rf "$MERGE_LOCK"
  fi
}
