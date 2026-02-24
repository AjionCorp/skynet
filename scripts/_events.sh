#!/usr/bin/env bash
# _events.sh — Structured event logging for the pipeline
# Sourced by _config.sh. Provides emit_event() to all scripts.
#
# Events are appended to $DEV_DIR/events.log in pipe-delimited format:
#   epoch|event_name|description
# This mirrors the fixer-stats.log pattern for structured log data.
#
# OPS-P2-1: Retention / rotation:
#   - SQLite (primary): db_prune_old_events() removes events older than 7 days,
#     called every 10 watchdog cycles from watchdog.sh.
#   - Flat file (compat): rotated when exceeding SKYNET_MAX_EVENTS_LOG_KB (default
#     1024 KB). Old files are shifted (.1 -> .2) and gzipped. Max 2 archives kept.

# Emit a named pipeline event with optional description and trace_id.
# Usage: emit_event "event_name" "description" ["trace_id"]
emit_event() {
  local event="$1"
  local description="${2:-}"
  local trace_id="${3:-${TRACE_ID:-}}"

  # Write to SQLite (primary)
  local _wid="${WORKER_ID:-${FIXER_ID:-}}"
  db_add_event "$event" "$description" "$_wid" "$trace_id" 2>/dev/null || true

  # Also append to flat file for backward compat during transition
  local events_log="$DEV_DIR/events.log"
  local max_kb="${SKYNET_MAX_EVENTS_LOG_KB:-1024}"

  # SH-P1-1: Write the event BEFORE checking rotation. This ensures the event
  # is always persisted regardless of what happens during rotation (e.g., process
  # killed between mv and write would lose the event in the old ordering).
  # Truncate to 3000 characters (not bytes). Bash ${var:0:N} operates on
  # characters in the current locale, so multi-byte UTF-8 sequences are
  # preserved intact — no mid-codepoint splits.
  local _safe_desc="${description:0:3000}"
  # Strip trailing backslash to avoid corrupted escape sequences after truncation
  case "$_safe_desc" in *'\\') _safe_desc="${_safe_desc%?}" ;; esac
  # Sanitize pipes in description to prevent column corruption in pipe-delimited format.
  # Uses tr instead of ${var//|/-} for bash 3.2 compatibility (pattern replacement with
  # literal pipe is unreliable in older bash versions).
  _safe_desc="$(printf '%s' "$_safe_desc" | tr '|' '-')"
  # Flat-file format: timestamp|event|description (pipe-delimited).
  # Description field has pipes sanitized to prevent column corruption.
  # The SQLite path (primary) does not have this limitation.
  local _line
  _line=$(printf '%s|%s|%s\n' "$(date +%s)" "$event" "$_safe_desc")
  if command -v flock >/dev/null 2>&1; then
    (flock -x 200; printf '%s\n' "$_line" >> "$events_log") 200>"${events_log}.lock"
  else
    # SH-P1-1: On macOS (no flock), use mkdir-based lock to prevent interleaved
    # writes from concurrent workers. Brief spin with 5 retries, 50ms apart.
    local _emit_lock="${SKYNET_LOCK_PREFIX:-/tmp/skynet}-events-emit.lock"
    local _emit_locked=false
    local _emit_i=0
    while [ "$_emit_i" -lt 5 ]; do
      if mkdir "$_emit_lock" 2>/dev/null; then
        _emit_locked=true
        break
      fi
      _emit_i=$((_emit_i + 1))
      # Brief sleep — perl usleep for sub-second on macOS (bash 3.2 compatible)
      perl -e 'select(undef,undef,undef,0.05)' 2>/dev/null || sleep 1
    done
    if $_emit_locked; then
      printf '%s\n' "$_line" >> "$events_log"
      rmdir "$_emit_lock" 2>/dev/null || rm -rf "$_emit_lock" 2>/dev/null || true
    else
      # Lock contention after retries — append anyway (partial line risk is
      # acceptable vs. losing the event entirely; SQLite is the primary store)
      printf '%s\n' "$_line" >> "$events_log"
    fi
  fi

  # Now check if rotation is needed (after the event is safely persisted)
  if [ -f "$events_log" ]; then
    # Size check uses bytes (wc -c) for file rotation threshold,
    # while truncation uses characters (${var:0:N}) to avoid mid-codepoint splits.
    # This is intentional: rotation cares about disk usage, truncation cares about correctness.
    local sz
    sz=$(wc -c < "$events_log" 2>/dev/null || echo 0)
    if [ "$sz" -gt $((max_kb * 1024)) ]; then
      # Brief mkdir-based lock around rotation to prevent concurrent writers
      # from rotating simultaneously (only the rotation section, not the emit).
      local _rot_lock="${SKYNET_LOCK_PREFIX:-/tmp/skynet}-events-rotate.lock"
      # NOTE: Pruned events are permanently deleted. For forensic retention,
      # configure an external log sink before enabling aggressive pruning.
      if mkdir "$_rot_lock" 2>/dev/null; then
        echo "$$" > "$_rot_lock/pid" 2>/dev/null || true
        # Remove old .2 archives first, then shift .1 -> .2, current -> .1, then gzip .2
        rm -f "${events_log}.2.gz" "${events_log}.2" 2>/dev/null || true
        if [ -f "${events_log}.1" ]; then
          mv "${events_log}.1" "${events_log}.2" 2>/dev/null || echo "events rotation: mv .1->.2 failed (disk full?)" >&2
        fi
        if ! mv "$events_log" "${events_log}.1" 2>/dev/null; then
          echo "events rotation: mv current->.1 failed (disk full?) — events log may grow unbounded" >&2
        fi
        [ -f "${events_log}.2" ] && gzip -f "${events_log}.2" 2>/dev/null &
        rmdir "$_rot_lock" 2>/dev/null || rm -rf "$_rot_lock" 2>/dev/null || true
      else
        # Stale lock recovery: if holder PID is dead or lock is older than 60s, reclaim
        local _rot_force=false
        if [ -f "$_rot_lock/pid" ]; then
          local _rot_pid
          _rot_pid=$(cat "$_rot_lock/pid" 2>/dev/null || echo "")
          if [ -n "$_rot_pid" ] && ! kill -0 "$_rot_pid" 2>/dev/null; then
            _rot_force=true
          fi
          if ! $_rot_force; then
            local _rot_mtime
            if [ "$(uname -s)" = "Darwin" ]; then
              _rot_mtime=$(stat -f %m "$_rot_lock/pid" 2>/dev/null || echo 0)
            else
              _rot_mtime=$(stat -c %Y "$_rot_lock/pid" 2>/dev/null || echo 0)
            fi
            if [ $(( $(date +%s) - _rot_mtime )) -gt 60 ]; then
              _rot_force=true
            fi
          fi
        else
          # No PID file — crash between mkdir and PID write
          _rot_force=true
        fi
        if $_rot_force; then
          rm -rf "$_rot_lock" 2>/dev/null || true
        fi
        # If lock was stale and reclaimed, next emit will pick up rotation
      fi
      # If lock acquisition failed, another writer is rotating — skip this cycle
    fi
  fi
}
