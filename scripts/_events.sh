#!/usr/bin/env bash
# _events.sh — Structured event logging for the pipeline
# Sourced by _config.sh. Provides emit_event() to all scripts.
#
# Events are appended to $DEV_DIR/events.log in pipe-delimited format:
#   epoch|event_name|description
# This mirrors the fixer-stats.log pattern for structured log data.

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
        # gzip runs in foreground (not &) so no orphan risk
        gzip -f "${events_log}.2" 2>/dev/null || true
        rm -f "${events_log}.2"
        if [ -f "${events_log}.1" ]; then
          mv "${events_log}.1" "${events_log}.2" 2>/dev/null || echo "events rotation: mv .1->.2 failed (disk full?)" >&2
        fi
        if ! mv "$events_log" "${events_log}.1" 2>/dev/null; then
          echo "events rotation: mv current->.1 failed (disk full?) — events log may grow unbounded" >&2
        fi
        rmdir "$_rot_lock" 2>/dev/null || true
      fi
      # If lock acquisition failed, another writer is rotating — skip this cycle
    fi
  fi
  # Truncate to 3000 characters (not bytes). Bash ${var:0:N} operates on
  # characters in the current locale, so multi-byte UTF-8 sequences are
  # preserved intact — no mid-codepoint splits.
  local _safe_desc="${description:0:3000}"
  # Strip trailing backslash to avoid corrupted escape sequences after truncation
  case "$_safe_desc" in *'\\') _safe_desc="${_safe_desc%?}" ;; esac
  printf '%s|%s|%s\n' "$(date +%s)" "$event" "$_safe_desc" >> "$events_log"
}
