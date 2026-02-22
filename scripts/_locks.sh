#!/usr/bin/env bash
# _locks.sh — Shared lock helpers for cross-worker coordination
# Sourced by _config.sh. Requires SKYNET_LOCK_PREFIX to be set.

MERGE_LOCK="${SKYNET_LOCK_PREFIX}-merge.lock"

# Acquire merge lock (mkdir-based mutex).
# Waits up to ~30s (60 retries x 0.5s). Stale lock timeout: 120s.
# Returns 0 on success, 1 on failure.
acquire_merge_lock() {
  local attempts=0
  while ! mkdir "$MERGE_LOCK" 2>/dev/null; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 60 ]; then
      # Check for stale lock (older than 120s — merges can be slow)
      if [ -d "$MERGE_LOCK" ]; then
        local lock_mtime
        lock_mtime=$(file_mtime "$MERGE_LOCK")
        local lock_age=$(( $(date +%s) - lock_mtime ))
        if [ "$lock_age" -gt 120 ]; then
          rm -rf "$MERGE_LOCK" 2>/dev/null || true
          mkdir "$MERGE_LOCK" 2>/dev/null && return 0
        fi
      fi
      return 1
    fi
    sleep 0.5
  done
  return 0
}

# Release merge lock.
release_merge_lock() {
  rmdir "$MERGE_LOCK" 2>/dev/null || rm -rf "$MERGE_LOCK" 2>/dev/null || true
}
