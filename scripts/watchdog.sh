#!/usr/bin/env bash
# watchdog.sh — Persistent dispatcher that keeps the pipeline alive
# Loops every 3 min. Checks if workers are idle with work waiting, kicks them off.
# Does NOT invoke Claude itself — just launches the worker scripts.
# Auth-aware: skips Claude-dependent workers when auth is expired.
# Crash recovery: detects stale locks, unclaims orphaned tasks, kills orphan processes.
set -uo pipefail  # no -e: loop must survive individual cycle failures

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_config.sh"

# _config.sh re-enables set -e; disable it again so the loop survives failures.
# NOTE: set +e is critical here — crash_recovery must complete all cleanup steps
# even if individual checks fail. Each cleanup step has its own error handling.
set +e

LOG="$SCRIPTS_DIR/watchdog.log"
WATCHDOG_LOCK_DIR="${SKYNET_LOCK_PREFIX}-watchdog.lock"
WATCHDOG_INTERVAL="${SKYNET_WATCHDOG_INTERVAL:-180}"  # seconds between cycles (default 3 min)
WORKTREE_BASE="${SKYNET_WORKTREE_BASE:-${DEV_DIR}/worktrees}"

cd "$PROJECT_DIR"

log() { _log "info" "WATCHDOG" "$*" "$LOG"; }

# --- Singleton enforcement via mkdir-based atomic lock ---
if mkdir "$WATCHDOG_LOCK_DIR" 2>/dev/null; then
  if ! echo "$$" > "$WATCHDOG_LOCK_DIR/pid" 2>/dev/null; then
    rmdir "$WATCHDOG_LOCK_DIR" 2>/dev/null || true
    log "PID write failed. Exiting."
    exit 1
  fi
else
  # Lock dir exists — check for stale lock (owner PID no longer running)
  if [ -d "$WATCHDOG_LOCK_DIR" ] && [ -f "$WATCHDOG_LOCK_DIR/pid" ]; then
    _existing_pid=$(cat "$WATCHDOG_LOCK_DIR/pid" 2>/dev/null || echo "")
    if [ -n "$_existing_pid" ] && kill -0 "$_existing_pid" 2>/dev/null; then
      log "Watchdog already running (PID $_existing_pid). Exiting."
      exit 0
    fi
    # Stale lock — reclaim atomically
    mv "$WATCHDOG_LOCK_DIR" "$WATCHDOG_LOCK_DIR.stale.$$" 2>/dev/null || true
    rm -rf "$WATCHDOG_LOCK_DIR.stale.$$" 2>/dev/null || true
    if mkdir "$WATCHDOG_LOCK_DIR" 2>/dev/null; then
      if ! echo "$$" > "$WATCHDOG_LOCK_DIR/pid" 2>/dev/null; then
        rmdir "$WATCHDOG_LOCK_DIR" 2>/dev/null || true
        log "PID write failed. Exiting."
        exit 1
      fi
    else
      log "Watchdog lock contention. Exiting."
      exit 0
    fi
  else
    log "Watchdog lock contention. Exiting."
    exit 0
  fi
fi

_DRAINING=false

_watchdog_cleanup() {
  # Stop admin dev server if we started it
  _dev_pidfile="$SCRIPTS_DIR/next-dev.pid"
  if [ -f "$_dev_pidfile" ]; then
    _dev_pid=$(cat "$_dev_pidfile" 2>/dev/null || echo "")
    if [ -n "$_dev_pid" ] && kill -0 "$_dev_pid" 2>/dev/null; then
      kill "$_dev_pid" 2>/dev/null || true
      log "Stopped admin dev server (PID $_dev_pid)"
    fi
    rm -f "$_dev_pidfile"
  fi
  rm -rf "$WATCHDOG_LOCK_DIR"
}

_watchdog_drain() {
  if $_DRAINING; then
    return  # Already draining, avoid re-entry
  fi
  _DRAINING=true
  log "Received shutdown signal, draining..."
  # Wait for any in-progress child processes to complete
  local _drain_timeout=60
  local _drain_waited=0
  while [ "$_drain_waited" -lt "$_drain_timeout" ]; do
    # Check if any child processes are still running
    if ! jobs -p 2>/dev/null | grep -q .; then
      break
    fi
    sleep 1
    _drain_waited=$((_drain_waited + 1))
  done
  if [ "$_drain_waited" -ge "$_drain_timeout" ]; then
    log "Drain timeout reached (${_drain_timeout}s), exiting with remaining children"
  else
    log "Drain complete, all children finished"
  fi
  _watchdog_cleanup
  exit 0
}

trap _watchdog_cleanup EXIT
trap _watchdog_drain INT TERM

log "Watchdog started (PID $$, interval ${WATCHDOG_INTERVAL}s)"

# --- Initial Pause (Boot-to-Pause) ---
# Pause on first boot only so operators can review state before workers run.
# If already unpaused (operator resumed), don't re-pause on watchdog restart.
if [ ! -f "$DEV_DIR/pipeline-paused" ]; then
  _pause_sentinel_tmp="$DEV_DIR/pipeline-paused.tmp.$$"
  (
    umask 077
    printf '{\n  "pausedAt": "%s",\n  "pausedBy": "system",\n  "reason": "Boot-to-pause (resume via Admin UI or skynet resume)"\n}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$_pause_sentinel_tmp"
  )
  mv "$_pause_sentinel_tmp" "$DEV_DIR/pipeline-paused" 2>/dev/null || true
  log "Pipeline initialized in PAUSED state. Use 'skynet resume' or Admin UI to start."
else
  log "Pipeline already paused (preserving existing pause state)."
fi

# --- Auto-start Admin Server ---
log "Starting admin dev server..."
bash "$SCRIPTS_DIR/start-dev.sh" >> "$LOG" 2>&1 || log "WARNING: Admin dev server failed to start (non-fatal)"

# Cycle counter for periodic maintenance (persists across subshell iterations)
# Stored in $DEV_DIR (project-private) instead of /tmp to avoid predictable path exploits.
_CYCLE_COUNTER_FILE="$DEV_DIR/.watchdog-cycle-count"
(umask 077; echo 0 > "$_CYCLE_COUNTER_FILE")

# --- Main loop ---
while ! $_DRAINING; do
(
# NOTE: set -euo pipefail inside this subshell is intentional. The outer loop
# catches subshell exit via `|| { ... }` so a single cycle failure does NOT
# kill the watchdog — it logs the failure and retries next cycle. This is
# preferred over set +e inside the subshell because it surfaces unexpected
# errors immediately rather than silently continuing with corrupted state.
set -euo pipefail
# NOTE: $LINENO in ERR trap may be relative to function/subshell scope, not the file.
trap 'log "Watchdog cycle failed at line $LINENO: $BASH_COMMAND"' ERR

# Rotate watchdog's own log if it exceeds configurable threshold
rotate_log_if_needed "$LOG"

# Rotate agent-metrics.log if it exceeds configurable threshold
rotate_log_if_needed "$DEV_DIR/agent-metrics.log"

# Trim logs to last 24h on each watchdog run
# OPS-P2-1: Export DB-initialized flag so clean-logs.sh skips redundant db_init
_SKYNET_DB_INITIALIZED=1 bash "$SCRIPTS_DIR/clean-logs.sh" 2>/dev/null || true

# Lightweight WAL checkpoint every cycle to prevent unbounded WAL growth.
# The full TRUNCATE checkpoint runs in db_maintenance() every 10 cycles.
db_wal_checkpoint

# P0-WAL: Check circuit breaker each cycle — log CRITICAL if degraded so operators
# see the warning in every cycle's output, not just the cycle where it failed.
if ! db_is_wal_healthy; then
  log "CRITICAL: WAL circuit breaker OPEN — $_db_wal_checkpoint_failures consecutive checkpoint failures. New task claims are BLOCKED. Run: sqlite3 $DB_PATH 'PRAGMA wal_checkpoint(TRUNCATE);' to recover, or restart the pipeline."
elif [ "$_db_wal_healthy" = "false" ]; then
  log "CRITICAL: WAL checkpoint previously failed — database may degrade. See .dev/db-wal-unhealthy sentinel."
fi

is_running() {
  local lockfile="$1"
  local pid=""
  if [ -d "$lockfile" ] && [ -f "$lockfile/pid" ]; then
    pid=$(cat "$lockfile/pid" 2>/dev/null || echo "")
  elif [ -f "$lockfile" ]; then
    pid=$(cat "$lockfile" 2>/dev/null || echo "")
  fi
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

# Kill a process by lockfile (dir or file). Best-effort, logs actions.
_kill_by_lock() {
  local lockfile="$1"
  local label="${2:-process}"
  local pid=""
  if [ -d "$lockfile" ] && [ -f "$lockfile/pid" ]; then
    pid=$(cat "$lockfile/pid" 2>/dev/null || echo "")
  elif [ -f "$lockfile" ]; then
    pid=$(cat "$lockfile" 2>/dev/null || echo "")
  fi
  [ -z "$pid" ] && return 1
  if kill -0 "$pid" 2>/dev/null; then
    log "Resetting $label (PID $pid)"
    kill -TERM "$pid" 2>/dev/null || true
    sleep 2
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
    return 0
  fi
  return 1
}

# --- Mission switch reset ---
_active_mission_slug=$(_get_active_mission_slug)
_prev_mission_slug=$(db_get_metadata "active_mission_slug" 2>/dev/null || echo "")
if [ -n "$_active_mission_slug" ] && [ "$_active_mission_slug" != "$_prev_mission_slug" ]; then
  log "Active mission switched from '${_prev_mission_slug:-none}' to '$_active_mission_slug' — resetting workers"
  emit_event "mission_switched" "Active mission switched from '${_prev_mission_slug:-none}' to '$_active_mission_slug'" 2>/dev/null || true

  # Backfill legacy tasks so unscoped tasks are assigned to a mission.
  if [ -n "$_prev_mission_slug" ]; then
    _bf_count=$(db_backfill_mission_hash "$_prev_mission_slug" 2>/dev/null || echo 0)
    if [ "${_bf_count:-0}" -gt 0 ] 2>/dev/null; then
      log "Backfilled $_bf_count legacy task(s) to mission '$_prev_mission_slug'"
    fi
  else
    _bf_count=$(db_backfill_mission_hash "$_active_mission_slug" 2>/dev/null || echo 0)
    if [ "${_bf_count:-0}" -gt 0 ] 2>/dev/null; then
      log "Backfilled $_bf_count legacy task(s) to mission '$_active_mission_slug'"
    fi
  fi

  # Unclaim in-flight tasks so workers restart cleanly on the new mission.
  _unclaimed=$(db_unclaim_all_tasks 2>/dev/null || echo 0)
  if [ "${_unclaimed:-0}" -gt 0 ] 2>/dev/null; then
    log "Reset claimed tasks: $_unclaimed unclaimed"
  fi

  db_set_metadata "active_mission_slug" "$_active_mission_slug" 2>/dev/null || true

  # Kill workers, fixers, and project-driver so they restart on the new mission.
  for _wid in $(seq 1 "${SKYNET_MAX_WORKERS:-4}"); do
    _kill_by_lock "${SKYNET_LOCK_PREFIX}-dev-worker-${_wid}.lock" "dev-worker-${_wid}" || true
    db_set_worker_idle "$_wid" "Mission switched — reset by watchdog" 2>/dev/null || true
  done
  _kill_by_lock "${SKYNET_LOCK_PREFIX}-task-fixer.lock" "task-fixer-1" || true
  for _fid in $(seq 2 "${SKYNET_MAX_FIXERS:-3}"); do
    _kill_by_lock "${SKYNET_LOCK_PREFIX}-task-fixer-${_fid}.lock" "task-fixer-${_fid}" || true
  done
  for _pd_lock in "${SKYNET_LOCK_PREFIX}"-project-driver-*.lock; do
    [ -e "$_pd_lock" ] || continue
    _kill_by_lock "$_pd_lock" "project-driver" || true
  done
fi

# --- Backlog mutex helpers (same pattern as dev-worker.sh) ---


# --- Crash recovery: detect stale locks, orphaned tasks, and zombie processes ---
# Decomposed into three phase helpers. All share the caller's scope for
# `recovered`, `_cr_stale_pids`, `_cr_orphaned_tasks`, `_cr_cleaned_worktrees`.
# IMPORTANT: Do NOT call these in subshells — they modify shared counters.

# Phase 1: Check all known lock files for stale/zombie PIDs
_cr_phase1_stale_locks() {
  local all_locks=()
  for _wid in $(seq 1 "${SKYNET_MAX_WORKERS:-4}"); do
    all_locks+=("${SKYNET_LOCK_PREFIX}-dev-worker-${_wid}.lock")
  done
  all_locks+=("${SKYNET_LOCK_PREFIX}-task-fixer.lock")
  for _fid in $(seq 2 "${SKYNET_MAX_FIXERS:-3}"); do
    all_locks+=("${SKYNET_LOCK_PREFIX}-task-fixer-${_fid}.lock")
  done
  all_locks+=("${SKYNET_LOCK_PREFIX}-project-driver-${_active_mission_slug:-global}.lock")
  for _pd_lock in "${SKYNET_LOCK_PREFIX}"-project-driver-*.lock; do
    [ -e "$_pd_lock" ] || continue
    all_locks+=("$_pd_lock")
  done

  for lockfile in "${all_locks[@]}"; do
    # Handle orphaned lock dirs (mkdir succeeded but process died before writing pid file)
    if [ -d "$lockfile" ] && [ ! -f "$lockfile/pid" ]; then
      # Guard: if the lock dir vanished between the -d check above and now,
      # file_mtime returns 0 → lock_age_secs ≈ 1.7B → false positive cleanup.
      [ -d "$lockfile" ] || continue
      local lock_age_secs=$(( $(date +%s) - $(file_mtime "$lockfile") ))
      if [ "$lock_age_secs" -gt 60 ]; then
        log "Removing orphaned lock dir (no pid file, ${lock_age_secs}s old): $lockfile"
        rm -rf "$lockfile"
      fi
      continue
    fi
    # Support both dir-based locks (lockfile/pid) and legacy file-based locks
    local lock_pid=""
    if [ -d "$lockfile" ] && [ -f "$lockfile/pid" ]; then
      lock_pid=$(cat "$lockfile/pid" 2>/dev/null || echo "")
      if [ -z "$lock_pid" ]; then
        # Zero-length PID file (crash between open and write) — treat as orphaned
        local lock_age_secs=$(( $(date +%s) - $(file_mtime "$lockfile") ))
        if [ "$lock_age_secs" -gt 60 ]; then
          log "Removing lock with empty PID file (${lock_age_secs}s old): $lockfile"
          rm -rf "$lockfile"
          recovered=$((recovered + 1))
          _cr_stale_pids=$((_cr_stale_pids + 1))
        fi
        continue
      fi
    elif [ -f "$lockfile" ]; then
      lock_pid=$(cat "$lockfile" 2>/dev/null || echo "")
    else
      continue
    fi
    [ -z "$lock_pid" ] && { rm -rf "$lockfile"; recovered=$((recovered + 1)); _cr_stale_pids=$((_cr_stale_pids + 1)); if [ "$recovered" -gt 500 ]; then log "WARNING: Crash recovery exceeded 500 items — possible cascading failure"; emit_event "crash_recovery_cap_hit" "Phase 1 hit 500-item limit" 2>/dev/null || true; break; fi; continue; }

    local stale=false

    if ! kill -0 "$lock_pid" 2>/dev/null; then
      # PID is dead — lock is stale (crash bypassed EXIT trap)
      stale=true
      log "Stale lock: $lockfile (PID $lock_pid dead)"
    else
      # PID alive — check if it's been running too long (zombie/hung worker)
      # Guard: if lockfile disappeared between the pid-read and now, skip it.
      # Without this, file_mtime returns 0 → lock_age_secs ≈ 1.7B → always stale.
      [ -e "$lockfile" ] || { log "Lock path vanished mid-check: $lockfile"; continue; }
      local lock_mtime
      lock_mtime=$(file_mtime "$lockfile")
      # Guard: if file_mtime returns 0 (stat failed, file vanished), skip
      # the stale check — treat as "unknown age, assume fresh".
      if [ "$lock_mtime" = "0" ]; then
        log "file_mtime returned 0 for $lockfile — skipping stale check"
        continue
      fi
      local now; now=$(date +%s)
      local lock_age_secs=$(( now - lock_mtime ))
      local stale_secs=$((SKYNET_STALE_MINUTES * 60))
      if [ "$lock_age_secs" -gt "$stale_secs" ]; then
        # Before killing, check if this worker has a fresh heartbeat.
        # Dev workers write heartbeat files; if the heartbeat is recent,
        # the worker is legitimately busy on a long task — skip it.
        local wid=""
        case "$lockfile" in
          *-dev-worker-*.lock) wid="${lockfile##*-dev-worker-}"; wid="${wid%.lock}" ;;
        esac
        if [ -n "$wid" ]; then
          local hb_file="$DEV_DIR/worker-${wid}.heartbeat"
          if [ -f "$hb_file" ]; then
            local hb_epoch
            hb_epoch=$(cat "$hb_file" 2>/dev/null || echo 0)
            local hb_age=$(( now - hb_epoch ))
            if [ "$hb_age" -le "$stale_secs" ]; then
              log "Worker $wid lock is old but heartbeat is fresh (${hb_age}s) — skipping"
              continue
            fi
          fi
        fi
        stale=true
        log "Zombie worker: $lockfile (PID $lock_pid, ${lock_age_secs}s old > ${stale_secs}s limit)"
        # Graceful kill first, then force — allow 10s for EXIT trap cleanup
        kill -TERM "$lock_pid" 2>/dev/null || true
        sleep 10
        kill -0 "$lock_pid" 2>/dev/null && kill -9 "$lock_pid" 2>/dev/null || true
      fi
    fi

    if $stale; then
      rm -rf "$lockfile"
      recovered=$((recovered + 1))
      _cr_stale_pids=$((_cr_stale_pids + 1))
      if [ "$recovered" -gt 500 ]; then
        log "WARNING: Crash recovery exceeded 500 items — possible cascading failure"
        emit_event "crash_recovery_cap_hit" "Phase 1 stale locks hit 500-item limit" 2>/dev/null || true
        break
      fi
    fi
  done
}

# Phase 2: Recover partial task states — unclaim [>] tasks from dead workers
_cr_phase2_orphaned_tasks() {
  for wid in $(seq 1 "${SKYNET_MAX_WORKERS:-4}"); do
    local wid_lock="${SKYNET_LOCK_PREFIX}-dev-worker-${wid}.lock"
    local task_file="$DEV_DIR/current-task-${wid}.md"

    # Skip if this worker is actually alive
    is_running "$wid_lock" && continue

    # Check if this worker's task file shows in_progress
    if [ -f "$task_file" ] && grep -q "in_progress" "$task_file" 2>/dev/null; then
      local stuck_title
      stuck_title=$(grep "^##" "$task_file" 2>/dev/null | head -1 | sed 's/^## //')
      if [ -n "$stuck_title" ]; then
        db_unclaim_task_by_title "$stuck_title" 2>/dev/null || log "WARNING: db_unclaim_task_by_title failed for '$stuck_title' (worker $wid) — task may remain orphaned"
        log "Unclaimed stuck task from worker $wid: $stuck_title"
        recovered=$((recovered + 1))
        _cr_orphaned_tasks=$((_cr_orphaned_tasks + 1))
        if [ "$recovered" -gt 500 ]; then
          log "WARNING: Crash recovery exceeded 500 items — possible cascading failure"
          emit_event "crash_recovery_cap_hit" "Phase 2 orphaned tasks hit 500-item limit" 2>/dev/null || true
          break
        fi
      fi
      # Reset current-task file and SQLite worker status to idle
      db_set_worker_idle "$wid" "dead worker recovered by watchdog" 2>/dev/null || log "WARNING: db_set_worker_idle failed for worker $wid — dashboard may show stale status"
      cat > "$task_file" <<IDLE_EOF
# Current Task
**Status:** idle
**Last failure:** $(date '+%Y-%m-%d %H:%M') -- ${stuck_title:-unknown} (dead worker recovered by watchdog)
IDLE_EOF
    fi
  done

  # Also check for any [>] entries in backlog with no live worker at all.
  # NOTE: This is intentional redundancy (belt-and-suspenders). The SQLite
  # orphan reconciliation above handles claimed tasks via the DB. This
  # file-based check is a legacy fallback that catches orphans visible in
  # backlog.md even if the DB reconciliation missed them (e.g., DB write
  # failed, or task was claimed before the SQLite migration).
  # Skip this block when SQLite DB exists — the post-crash_recovery SQLite
  # reconciliation (lines below) handles it authoritatively.
  if [ -f "$DB_PATH" ]; then
    : # SQLite reconciliation will handle orphaned claims — skip file-based check
  elif [ -f "$BACKLOG" ]; then
    # DEAD CODE NOTE: This branch is effectively unreachable because db_init()
    # in _config.sh always creates the DB file before watchdog runs. The branch
    # (including the db_unclaim_task_by_title call below) is retained as a
    # defensive fallback for edge cases where the DB file is deleted at runtime.
    local any_worker_alive=false
    for wid in $(seq 1 "${SKYNET_MAX_WORKERS:-4}"); do
      is_running "${SKYNET_LOCK_PREFIX}-dev-worker-${wid}.lock" && any_worker_alive=true
    done
    is_running "${SKYNET_LOCK_PREFIX}-task-fixer.lock" && any_worker_alive=true
    for _fid in $(seq 2 "${SKYNET_MAX_FIXERS:-3}"); do
      is_running "${SKYNET_LOCK_PREFIX}-task-fixer-${_fid}.lock" && any_worker_alive=true
    done

    if ! $any_worker_alive; then
      local claimed_lines
      claimed_lines=$(grep '^\- \[>\]' "$BACKLOG" 2>/dev/null || true)
      if [ -n "$claimed_lines" ]; then
        while IFS= read -r line; do
          local title="${line#- \[>\] }"
          db_unclaim_task_by_title "$title" 2>/dev/null || log "WARNING: db_unclaim_task_by_title failed for orphaned task '$title' — task may stay claimed"
          log "Unclaimed orphaned task (no workers alive): $title"
          recovered=$((recovered + 1))
          _cr_orphaned_tasks=$((_cr_orphaned_tasks + 1))
          if [ "$recovered" -gt 500 ]; then
            log "WARNING: Crash recovery exceeded 500 items — possible cascading failure"
            emit_event "crash_recovery_cap_hit" "Phase 2 orphaned claims hit 500-item limit" 2>/dev/null || true
            break
          fi
        done <<< "$claimed_lines"
      fi
    fi
  fi
}

# Minimum expected command length for a skynet worker process. If ps output is
# shorter, it may be truncated and we cannot safely verify the PID identity.
_SKYNET_PS_MIN_CMD_LEN=100

# _validate_skynet_orphan_pid PID WORKTREE_PATH
# Returns 0 if the PID is a genuine skynet worker process in the given worktree.
# Returns 1 (skip) if the process is unrelated, recycled, or ps output is truncated.
# Uses exact path matching anchored to path separators and requires a recognizable
# skynet worker pattern (dev-worker, task-fixer, claude, skynet) in the command.
_validate_skynet_orphan_pid() {
  local pid="$1" wt_path="$2"
  local cmd
  cmd=$(ps -ww -p "$pid" -o command= 2>/dev/null || echo "")

  # Empty command — process already exited
  [ -z "$cmd" ] && return 1

  # Truncation guard: if command is suspiciously short, we cannot trust the match.
  # macOS ps can truncate to terminal width or COLUMNS; the full worktree path
  # alone is typically 50+ chars, so a short command likely lost critical context.
  if [ "${#cmd}" -lt "$_SKYNET_PS_MIN_CMD_LEN" ]; then
    log "WARNING: ps output for PID $pid is only ${#cmd} chars (< ${_SKYNET_PS_MIN_CMD_LEN}), may be truncated — skipping kill"
    return 1
  fi

  # Exact path match: the worktree path must appear as a complete path component,
  # bounded by start-of-string, space, or path separator — not as a substring of
  # a longer path. We check for the path followed by end-of-string, space, or '/'.
  local path_matched=false
  case "$cmd" in
    # Path at end of command
    *" ${wt_path}") path_matched=true ;;
    # Path followed by space (argument separator)
    *" ${wt_path} "*) path_matched=true ;;
    # Path followed by / (subpath reference)
    *" ${wt_path}/"*) path_matched=true ;;
    # Path at start of command (unlikely but defensive)
    "${wt_path} "*|"${wt_path}/"*) path_matched=true ;;
  esac
  if ! $path_matched; then
    log "PID $pid cmd does not contain exact worktree path (now: ${cmd:0:80}), skipping"
    return 1
  fi

  # Skynet worker pattern: the command must also contain a recognizable skynet
  # identifier. This prevents killing unrelated processes that happen to reference
  # the worktree path (e.g., an editor, a file manager, a log tailer).
  local pattern_matched=false
  case "$cmd" in
    *dev-worker*|*task-fixer*|*claude*|*skynet*|*watchdog*) pattern_matched=true ;;
  esac
  if ! $pattern_matched; then
    log "PID $pid in worktree but not a skynet worker (cmd: ${cmd:0:80}), skipping"
    return 1
  fi

  return 0
}

# Phase 3: Kill orphan processes in worktree directories and clean up worktrees
_cr_phase3_orphan_worktrees() {
  local worktree_dirs=()
  for _wid in $(seq 1 "${SKYNET_MAX_WORKERS:-4}"); do
    worktree_dirs+=("${WORKTREE_BASE}/w${_wid}|${SKYNET_LOCK_PREFIX}-dev-worker-${_wid}.lock")
  done
  worktree_dirs+=("${WORKTREE_BASE}/fixer-1|${SKYNET_LOCK_PREFIX}-task-fixer.lock")
  for _fid in $(seq 2 "${SKYNET_MAX_FIXERS:-3}"); do
    worktree_dirs+=("${WORKTREE_BASE}/fixer-${_fid}|${SKYNET_LOCK_PREFIX}-task-fixer-${_fid}.lock")
  done

  for entry in "${worktree_dirs[@]}"; do
    local wt_dir="${entry%%|*}"
    local wt_lock="${entry##*|}"

    # If worktree exists but its worker is NOT running — it's orphaned
    [ -d "$wt_dir" ] || continue
    is_running "$wt_lock" && continue

    # Kill any orphan processes running inside the worktree (claude, node, etc.)
    # NOTE: pgrep -f is inherently fuzzy — it could match unrelated processes whose
    # command line contains the worktree path as a substring. The regex escaping
    # and worktree-specific path pattern mitigate this. False positive risk is low.
    # Mitigations: (1) resolved absolute path via pwd -P narrows the pattern,
    # (2) regex anchors "bash.*path([ /]|$)" require bash prefix and path boundary,
    # (3) own PID and grep processes are explicitly excluded from the result.
    local resolved_wt_dir
    resolved_wt_dir=$(cd "$wt_dir" 2>/dev/null && pwd -P || echo "$wt_dir")
    local orphan_pids
    # Escape regex metacharacters in path for safe pgrep -f matching
    local escaped_wt_dir
    escaped_wt_dir=$(printf '%s' "$resolved_wt_dir" | sed 's/[.[\*^$(){}|+?\\]/\\&/g')
    # Narrow match: only kill processes whose command line contains the exact worktree
    # path as a directory argument to bash (not as a substring of log messages or other
    # paths). Exclude our own PID and pgrep/grep processes.
    local _my_pid=$$
    if command -v pgrep >/dev/null 2>&1; then
      orphan_pids=$(pgrep -f "bash.*${escaped_wt_dir}([ /]|$)" 2>/dev/null | grep -v "^${_my_pid}$" || true)
    else
      orphan_pids=$(ps ax -o pid= -o command= 2>/dev/null | grep -E "bash.*${escaped_wt_dir}([ /]|$)" | grep -v grep | grep -v "^ *${_my_pid} " | awk '{print $1}' || true)
    fi
    if [ -n "$orphan_pids" ]; then
      log "Killing orphan processes in $wt_dir: $(echo "$orphan_pids" | tr '\n' ' ')"
      # OPS-P1-3/P1-4 + P0-1: Re-validate each PID before killing to guard against
      # PID wraparound race AND substring match false positives. Each PID must pass:
      # (1) process still alive, (2) exact worktree path match (not substring),
      # (3) recognized skynet worker pattern, (4) ps output not truncated.
      while read -r _opid; do
        [ -z "$_opid" ] && continue
        kill -0 "$_opid" 2>/dev/null || continue
        if _validate_skynet_orphan_pid "$_opid" "$resolved_wt_dir"; then
          kill -TERM "$_opid" 2>/dev/null; log "Killed orphan process $_opid"
        fi
      done <<< "$orphan_pids"
      sleep 1
      while read -r _opid; do
        [ -z "$_opid" ] && continue
        kill -0 "$_opid" 2>/dev/null || continue
        # Re-verify before SIGKILL escalation (same strict validation)
        if _validate_skynet_orphan_pid "$_opid" "$resolved_wt_dir"; then
          kill -9 "$_opid" 2>/dev/null; log "Force-killed orphan process $_opid"
        fi
      done <<< "$orphan_pids"
    fi

    # Re-check: worker may have started between initial check and now
    is_running "$wt_lock" && continue

    # Remove the orphan worktree
    cd "$PROJECT_DIR"
    git worktree remove "$wt_dir" --force 2>/dev/null || rm -rf "$wt_dir" 2>/dev/null || true
    git worktree prune 2>/dev/null || true
    log "Cleaned orphan worktree: $wt_dir"
    recovered=$((recovered + 1))
    _cr_cleaned_worktrees=$((_cr_cleaned_worktrees + 1))
    if [ "$recovered" -gt 500 ]; then
      log "WARNING: Crash recovery exceeded 500 items — possible cascading failure"
      emit_event "crash_recovery_cap_hit" "Phase 3 worktree cleanup hit 500-item limit" 2>/dev/null || true
      break
    fi
  done
}

# SH-P1-4: Track consecutive cycles where the 500-item cap is hit.
# If 3+ consecutive cycles hit the cap, remaining items are silently skipped
# forever — escalate with a CRITICAL event so operators investigate.
# OPS-R21-P1-2: Persist consecutive cap counter to survive process restarts
_cr_caps_file="${DEV_DIR}/cr-consecutive-caps"
if [ -f "$_cr_caps_file" ]; then
  _cr_consecutive_caps=$(cat "$_cr_caps_file" 2>/dev/null || echo "0")
  # Validate numeric
  case "$_cr_consecutive_caps" in
    ''|*[!0-9]*) _cr_consecutive_caps=0 ;;
  esac
else
  _cr_consecutive_caps=0
fi

crash_recovery() {
  local recovered=0
  local _cr_stale_pids=0 _cr_orphaned_tasks=0 _cr_cleaned_worktrees=0
  # OPS-P2-2: Track phase errors for cascading failure detection
  local _cr_phase_errors=0

  _cr_phase1_stale_locks || _cr_phase_errors=$((_cr_phase_errors + 1))
  if [ "$recovered" -gt 500 ]; then
    log "WARNING: Crash recovery exceeded 500 items after phase 1 — skipping remaining phases"
  else
    _cr_phase2_orphaned_tasks || _cr_phase_errors=$((_cr_phase_errors + 1))
  fi
  if [ "$recovered" -gt 500 ]; then
    [ "$_cr_stale_pids" -gt 0 ] || log "WARNING: Crash recovery exceeded 500 items after phase 2 — skipping phase 3"
  else
    _cr_phase3_orphan_worktrees || _cr_phase_errors=$((_cr_phase_errors + 1))
  fi

  if [ "$recovered" -gt 0 ]; then
    # SH-P2-2: Cumulative summary — totals tasks recovered, orphan worktrees cleaned, locks released
    log "Crash recovery: $recovered item(s) — ${_cr_stale_pids} locks released, ${_cr_orphaned_tasks} tasks recovered, ${_cr_cleaned_worktrees} worktrees cleaned"
    emit_event "crash_recovery_summary" "recovered=$recovered locks=${_cr_stale_pids} tasks=${_cr_orphaned_tasks} worktrees=${_cr_cleaned_worktrees}" 2>/dev/null || true
    tg "🔄 *$SKYNET_PROJECT_NAME_UPPER WATCHDOG*: Crash recovery — ${_cr_stale_pids} locks released, ${_cr_orphaned_tasks} tasks recovered, ${_cr_cleaned_worktrees} worktrees"
  fi

  # Alert operators when the 500-item safety limit was hit — recovery may be incomplete
  if [ "$recovered" -gt 500 ]; then
    emit_event "crash_recovery_limit" "Crash recovery hit 500-item limit — some items may not have been recovered"
    tg "🚨 *$SKYNET_PROJECT_NAME_UPPER WATCHDOG*: Crash recovery hit 500-item limit — recovery may be incomplete. Investigate immediately."
    # SH-P1-4: Track consecutive cap hits and escalate if persistent
    _cr_consecutive_caps=$((_cr_consecutive_caps + 1))
    echo "$_cr_consecutive_caps" > "$_cr_caps_file" 2>/dev/null || true
    if [ "$_cr_consecutive_caps" -ge 3 ]; then
      log "CRITICAL: Crash recovery hit 500-item cap for ${_cr_consecutive_caps} consecutive cycles — items are being permanently skipped"
      emit_event "crash_recovery_cascade" "500-item cap hit ${_cr_consecutive_caps} consecutive cycles — possible unbounded stale state" 2>/dev/null || true
      tg "🚨 *$SKYNET_PROJECT_NAME_UPPER WATCHDOG*: CRITICAL — Crash recovery cap hit ${_cr_consecutive_caps} consecutive cycles. Stale items are accumulating. Investigate immediately."
    fi
  else
    # SH-P1-4 + OPS-R21-P1-2: Only reset consecutive cap counter when recovered < 400,
    # indicating the situation is truly resolved (not just under the 500 cap by 1-2 items)
    if [ "$recovered" -lt 400 ]; then
      _cr_consecutive_caps=0
      echo "0" > "$_cr_caps_file" 2>/dev/null || true
    else
      log "WARNING: Crash recovery completed ($recovered items) but near 500-cap threshold — preserving consecutive cap counter at $_cr_consecutive_caps"
    fi
  fi

  # OPS-P2-2: Escalate when multiple phases fail — indicates systemic issue
  if [ "$_cr_phase_errors" -gt 1 ]; then
    log "CRITICAL: ${_cr_phase_errors} crash recovery phases failed — possible cascading failure"
    emit_event "crash_recovery_cascade" "${_cr_phase_errors} phases failed in crash recovery" 2>/dev/null || true
    tg "🚨 *$SKYNET_PROJECT_NAME_UPPER WATCHDOG*: CRITICAL — ${_cr_phase_errors} crash recovery phases failed. Investigate immediately."
  fi
}

# --- Run crash recovery before dispatching ---
# OPS-P2-2: Wrap crash_recovery with error isolation so remaining phases run even if it fails
crash_recovery || { log "Phase: crash_recovery failed, continuing"; true; }

# --- Reconcile orphaned 'claimed' tasks ---
# NOTE: Reconciliation counters are logged per-event (log + emit_event) rather
# than aggregated, ensuring accuracy regardless of which code path runs.
# If a task is 'claimed' in SQLite but the worker that claimed it is either dead
# or working on a different task, unclaim it back to 'pending'.
# Time guard: only reconcile claims older than ORPHAN_CUTOFF to avoid racing with
# the ~50-200ms gap between db_claim_next_task and db_set_worker_status in dev-worker.
# OPS-P2-2: Error isolation — wrap in braces with || to ensure subsequent phases run
{
_ORPHAN_CUTOFF="${SKYNET_ORPHAN_CUTOFF_SECONDS:-120}"
case "$_ORPHAN_CUTOFF" in ''|*[!0-9]*) _ORPHAN_CUTOFF=120 ;; esac
_orphaned_claimed=$(_db_sep "
  SELECT t.id, t.title, t.worker_id
  FROM tasks t
  WHERE t.status = 'claimed' AND t.worker_id IS NOT NULL
    AND t.claimed_at < datetime('now', '-$_ORPHAN_CUTOFF seconds')
    AND NOT EXISTS (
      SELECT 1 FROM workers w
      WHERE w.id = t.worker_id AND w.status = 'in_progress' AND w.current_task_id = t.id
    );
" 2>/dev/null || true)
if [ -n "$_orphaned_claimed" ]; then
  while IFS="$_DB_SEP" read -r _oc_id _oc_title _oc_wid; do
    [ -z "$_oc_id" ] && continue
    db_unclaim_task "$_oc_id" 2>/dev/null || log "WARNING: db_unclaim_task failed for orphaned claim id=$_oc_id ('$_oc_title') — task may remain stuck as claimed"
    log "Reconciled orphaned claim: task '$_oc_title' (id=$_oc_id, worker=$_oc_wid)"
    emit_event "orphaned_claim_reconciled" "Task '$_oc_title' (id=$_oc_id) unclaimed — worker $_oc_wid not actively working on it" 2>/dev/null || true
  done <<< "$_orphaned_claimed"
fi
} || { log "Phase: orphaned-claims reconciliation failed, continuing"; true; }

# --- Reconcile stale 'fixing-N' tasks ---
# If a fixer crashes, the task stays in 'fixing-N' status forever because
# db_get_pending_failures() only queries status='failed'. Detect stale fixing
# tasks where the fixer is dead and reset them to 'failed' for retry.
# OPS-P2-2: Error isolation — wrap in braces with || to ensure subsequent phases run
{
_stale_fixing=$(_db_sep "
  SELECT id, title, fixer_id
  FROM tasks
  WHERE status LIKE 'fixing-%'
    AND updated_at < datetime('now', '-$_ORPHAN_CUTOFF seconds');
" 2>/dev/null || true)
if [ -n "$_stale_fixing" ]; then
  while IFS="$_DB_SEP" read -r _sf_id _sf_title _sf_fid; do
    [ -z "$_sf_id" ] && continue
    _sf_fid="${_sf_fid:-1}"
    # Determine fixer lock path (fixer 1 uses task-fixer.lock, 2+ use task-fixer-N.lock)
    if [ "$_sf_fid" = "1" ]; then
      _sf_lock="${SKYNET_LOCK_PREFIX}-task-fixer.lock"
    else
      _sf_lock="${SKYNET_LOCK_PREFIX}-task-fixer-${_sf_fid}.lock"
    fi
    if is_running "$_sf_lock"; then
      continue  # Fixer is alive — task is legitimately being worked on
    fi
    # Fixer is dead — reset task to 'failed' for retry
    _sf_int_id=$(_sql_int "$_sf_id")
    _db "
      UPDATE tasks SET status='failed', fixer_id=NULL, updated_at=datetime('now')
      WHERE id=$_sf_int_id AND status LIKE 'fixing-%';
    " 2>/dev/null || log "WARNING: DB update failed for stale fixing task '$_sf_title' (id=$_sf_id) — task may remain stuck in fixing state"
    log "Reconciled stale fixing task: '$_sf_title' (id=$_sf_id, fixer=$_sf_fid) — reset to failed"
    emit_event "stale_fixing_reconciled" "Task '$_sf_title' (id=$_sf_id) reset to failed — fixer $_sf_fid is dead" 2>/dev/null || true
  done <<< "$_stale_fixing"
fi
} || { log "Phase: stale-fixing reconciliation failed, continuing"; true; }

# --- Sync backlog.md markers after reconciliation ---
# After crash recovery and orphaned-claim reconciliation, SQLite may have tasks
# reset from 'claimed' to 'pending' — but backlog.md still shows stale [>]
# markers. Regenerate backlog.md from the authoritative SQLite state so the
# markdown view matches reality. Uses the existing atomic export (tmp+mv).
# Only runs when there's a DB and a backlog file to update.
#
# Two-level check:
#   1. Quick count comparison catches most divergences cheaply.
#   2. Per-title verification catches cases where counts coincidentally match
#      but different tasks are claimed (e.g., Task A unclaimed + Task B claimed
#      in the same cycle). Without this, stale [>] markers persist silently.
{
if [ -f "$DB_PATH" ] && [ -f "$BACKLOG" ]; then
  _bl_db_pending=$(_db "SELECT COUNT(*) FROM tasks WHERE status='pending';" 2>/dev/null || echo "")
  _bl_db_claimed=$(_db "SELECT COUNT(*) FROM tasks WHERE status='claimed';" 2>/dev/null || echo "")
  _bl_md_pending=$(grep -c '^\- \[ \]' "$BACKLOG" 2>/dev/null || echo "0")
  _bl_md_claimed=$(grep -c '^\- \[>\]' "$BACKLOG" 2>/dev/null || echo "0")

  _bl_needs_sync=false
  _bl_stale_count=0

  if [ "${_bl_db_pending:-}" != "$_bl_md_pending" ] || [ "${_bl_db_claimed:-}" != "$_bl_md_claimed" ]; then
    # Count mismatch — definitely need to sync
    _bl_needs_sync=true
    # Estimate stale markers from the count surplus in backlog vs DB
    _bl_stale_count=$(( ${_bl_md_claimed:-0} - ${_bl_db_claimed:-0} ))
    [ "$_bl_stale_count" -lt 0 ] && _bl_stale_count=0
  elif [ "${_bl_md_claimed:-0}" -gt 0 ]; then
    # Counts match but there are claimed entries — verify individual titles.
    # Get claimed titles from DB (one per line, sorted for reproducibility).
    _bl_db_claimed_titles=$(_db "SELECT title FROM tasks WHERE status='claimed' ORDER BY title;" 2>/dev/null || true)
    # For each [>] line in backlog.md, check if its title is actually claimed in DB.
    while IFS= read -r _scl_line; do
      [ -z "$_scl_line" ] && continue
      # Extract title: "- [>] [TAG] Title — Desc | blockedBy: x" → "Title"
      _scl_title=$(echo "$_scl_line" | sed 's/^- \[>\] \[[^]]*\] //;s/ — .*//;s/ | blockedBy:.*//')
      [ -z "$_scl_title" ] && continue
      # Exact whole-line match (-xF) to avoid substring false positives
      if ! echo "$_bl_db_claimed_titles" | grep -qxF "$_scl_title"; then
        _bl_stale_count=$((_bl_stale_count + 1))
      fi
    done < <(grep '^\- \[>\]' "$BACKLOG" 2>/dev/null || true)
    [ "$_bl_stale_count" -gt 0 ] && _bl_needs_sync=true
  fi

  if $_bl_needs_sync; then
    db_export_backlog "$BACKLOG" 2>/dev/null || log "WARNING: db_export_backlog failed during stale-claim sync"
    log "Synced backlog.md markers (DB: ${_bl_db_pending} pending/${_bl_db_claimed} claimed, was: ${_bl_md_pending} pending/${_bl_md_claimed} claimed)"
    emit_event "backlog_marker_synced" "pending=${_bl_db_pending} claimed=${_bl_db_claimed} was_pending=${_bl_md_pending} was_claimed=${_bl_md_claimed}" 2>/dev/null || true
    if [ "$_bl_stale_count" -gt 0 ]; then
      log "Reverted ${_bl_stale_count} stale [>] claimed markers (no matching claimed task in DB)"
      emit_event "stale_claims_reverted" "count=${_bl_stale_count}" 2>/dev/null || true
    fi
  fi
fi
} || { log "Phase: backlog marker sync failed, continuing"; true; }

# --- Proactive merge lock cleanup ---
# If the merge lock holder's PID is dead (or PID file is missing, indicating a
# crash between mkdir and PID write), remove the lock immediately rather than
# waiting for the 120s stale timeout to expire.
# TOCTOU guard: re-read the PID right before removal. If it changed between the
# first and second read, a new worker legitimately acquired the lock — skip.
# NOTE: There is an inherent TOCTOU race between reading the PID file and
# checking kill -0. A new process could reuse the PID in between. This is
# mitigated by: (1) the double-read pattern that catches PID changes, and
# (2) the short time window making PID reuse statistically improbable.
if [ -d "$MERGE_LOCK" ]; then
  _ml_pid_first=""
  [ -f "$MERGE_LOCK/pid" ] && _ml_pid_first=$(cat "$MERGE_LOCK/pid" 2>/dev/null || echo "")
  if [ -z "$_ml_pid_first" ]; then
    # No PID file — process crashed between mkdir and PID write; reclaim.
    # Re-check: if a PID file appeared in the meantime, another worker took over.
    _ml_pid_second=""
    [ -f "$MERGE_LOCK/pid" ] && _ml_pid_second=$(cat "$MERGE_LOCK/pid" 2>/dev/null || echo "")
    if [ -z "$_ml_pid_second" ]; then
      log "Merge lock has no PID file — removing stale lock proactively"
      rm -rf "$MERGE_LOCK" 2>/dev/null || true
    fi
  elif ! kill -0 "$_ml_pid_first" 2>/dev/null; then
    # PID appears dead — re-read to guard against TOCTOU race where a new
    # worker acquired the lock between our first read and this removal.
    _ml_pid_second=""
    [ -f "$MERGE_LOCK/pid" ] && _ml_pid_second=$(cat "$MERGE_LOCK/pid" 2>/dev/null || echo "")
    if [ "$_ml_pid_second" = "$_ml_pid_first" ] && ! kill -0 "$_ml_pid_first" 2>/dev/null; then
      log "Merge lock held by dead PID $_ml_pid_first — removing proactively"
      rm -rf "$MERGE_LOCK" 2>/dev/null || true
    else
      log "Merge lock PID changed ($_ml_pid_first -> $_ml_pid_second) — skipping removal"
    fi
  fi
fi

# Clean up stale flock owner files from crashed workers (transition support)
if [ -f "${SKYNET_LOCK_PREFIX}-merge.flock.owner" ]; then
  _flock_owner_pid=$(cat "${SKYNET_LOCK_PREFIX}-merge.flock.owner" 2>/dev/null || echo "")
  if [ -n "$_flock_owner_pid" ] && ! kill -0 "$_flock_owner_pid" 2>/dev/null; then
    rm -f "${SKYNET_LOCK_PREFIX}-merge.flock.owner" 2>/dev/null || true
    log "Cleaned up stale flock owner file for dead PID $_flock_owner_pid"
  fi
fi

# --- SQLite integrity check ---
# Quick check that the database is not corrupted. If it is, alert the operator
# and continue in file-fallback mode (db functions will fail gracefully).
_db_healthy=true
if [ -f "$DB_PATH" ]; then
  _db_check=$(_db "PRAGMA quick_check;" 2>&1)
  if [ "$_db_check" != "ok" ]; then
    _db_healthy=false
    log "ERROR: SQLite database failed integrity check: $_db_check"
    tg "🚨 *$SKYNET_PROJECT_NAME_UPPER WATCHDOG*: SQLite database corrupted — attempting automatic restore."

    # --- Automatic DB restore from most recent daily backup ---
    # ls -1t sorts by mtime (not locale-dependent lexicographic order), so LC_ALL is not needed
    _restore_backup=$(ls -1t "$DEV_DIR/db-backups"/skynet.db.2* 2>/dev/null | head -1)
    # Validate restore path: must be non-empty, a regular file, and non-zero size
    if [ -n "$_restore_backup" ] && [ ! -f "$_restore_backup" ]; then
      log "WARNING: Restore path '$_restore_backup' is not a regular file — skipping"
      _restore_backup=""
    fi
    if [ -n "$_restore_backup" ] && [ ! -s "$_restore_backup" ]; then
      log "WARNING: Restore path '$_restore_backup' is empty — skipping"
      _restore_backup=""
    fi
    if [ -n "$_restore_backup" ]; then
      log "Attempting automatic DB restore from $_restore_backup"
      # OPS-P1-2: Use full integrity_check for backup validation (covers all data pages,
      # not just ~2% like quick_check). Wrapped with a 30s timeout to prevent hangs on
      # large or corrupted backup files.
      if command -v timeout >/dev/null 2>&1; then
        _backup_check=$(timeout 30 sqlite3 "$_restore_backup" "PRAGMA integrity_check;" 2>/dev/null | head -1)
      else
        _backup_check=$(sqlite3 "$_restore_backup" "PRAGMA integrity_check;" 2>/dev/null | head -1)
      fi
      if [ "$_backup_check" = "ok" ]; then
        # Atomically move corrupted DB out of the way so concurrent workers
        # cannot read partial state during the restore process.
        _corrupted_path="$DB_PATH.corrupted.$(date +%s)"
        mv "$DB_PATH" "$_corrupted_path" 2>/dev/null || {
          log "CRITICAL: Failed to rename corrupted DB — cannot proceed with restore"
          tg "🚨 *$SKYNET_PROJECT_NAME_UPPER WATCHDOG*: DB rename failed. Manual intervention required."
        }
        if [ ! -f "$DB_PATH" ]; then
          # Restore to a temp file first, verify integrity, then atomically rename into place
          # $_restore_tmp is built from DB_PATH + .restore-tmp.$$ — no special chars possible.
          _restore_tmp="$DB_PATH.restore-tmp.$$"
          sqlite3 "$_restore_backup" ".backup '${_restore_tmp}'" 2>/dev/null
          # OPS-P1-2: Full integrity_check for restored DB validation with 30s timeout
          if command -v timeout >/dev/null 2>&1; then
            _restore_check=$(timeout 30 sqlite3 "$_restore_tmp" "PRAGMA integrity_check;" 2>/dev/null | head -1)
          else
            _restore_check=$(sqlite3 "$_restore_tmp" "PRAGMA integrity_check;" 2>/dev/null | head -1)
          fi
          if [ "$_restore_check" = "ok" ]; then
            if [ -f "$DB_PATH" ]; then
              log "DB recreated by another process during restore — skipping"
              rm -f "$_restore_tmp"
            else
              mv "$_restore_tmp" "$DB_PATH"
              _db_healthy=true
              log "DB restore succeeded from $_restore_backup"
              tg "✅ *$SKYNET_PROJECT_NAME_UPPER WATCHDOG*: SQLite auto-restored from backup $_restore_backup"
            fi
          else
            rm -f "$_restore_tmp" 2>/dev/null || true
            # Restore the corrupted copy back so at least we have a DB file
            mv "$_corrupted_path" "$DB_PATH" 2>/dev/null || true
            log "CRITICAL: DB restore verification failed"
            tg "🚨 *$SKYNET_PROJECT_NAME_UPPER WATCHDOG*: DB restore failed verification. Manual intervention required."
          fi
        fi
      else
        log "CRITICAL: Backup file $_restore_backup is also corrupted"
        tg "🚨 *$SKYNET_PROJECT_NAME_UPPER WATCHDOG*: Backup also corrupted. Manual intervention required."
      fi
    else
      log "CRITICAL: No backup files found — cannot auto-restore"
      tg "🚨 *$SKYNET_PROJECT_NAME_UPPER WATCHDOG*: No backups available for restore. Manual intervention required."
    fi
  fi
fi

# --- Daily SQLite backup ---
# Uses sqlite3 .backup (safe during WAL writes). Keeps 7 days, rotates daily.
_backup_sentinel="$DEV_DIR/.db-backup-sentinel-$(date +%Y%m%d)"
if [ -f "$DB_PATH" ] && $_db_healthy && [ ! -f "$_backup_sentinel" ]; then
  mkdir -p "$DEV_DIR/db-backups"
  _backup_file="$DEV_DIR/db-backups/skynet.db.$(date +%Y%m%d)"
  # Validate backup path is safe for sqlite3 .backup command
  case "$_backup_file" in
    *"'"*|*'\\'*) log "WARNING: Unsafe characters in backup path, skipping backup" ;;
    *)
      if sqlite3 "$DB_PATH" ".backup '${_backup_file}'" 2>/dev/null; then
        (umask 077; touch "$_backup_sentinel")
        log "Daily DB backup created: $_backup_file"
        # Rotate: keep 7 days
        # ls -1t sorts by mtime — locale-independent; keeping 7 newest backups
        ls -1t "$DEV_DIR/db-backups"/skynet.db.* 2>/dev/null | tail -n +8 | while read -r _old; do
          rm -f "$_old"
        done
      else
        log "WARNING: Daily DB backup failed"
      fi
    ;;
  esac
fi

# Clean up old /tmp sentinel files (older than 7 days) to prevent accumulation
find /tmp -maxdepth 1 -name "skynet-${SKYNET_PROJECT_NAME}-*" -mtime +7 -type f -exec rm -f {} + 2>/dev/null || true

# Clean up old .dev sentinel files (>7 days) to prevent accumulation in devDir
find "$DEV_DIR" -maxdepth 1 -name '.db-*-sentinel-*' -mtime +7 -delete 2>/dev/null || true

# --- Validate backlog health (duplicates, orphaned claims, bad refs) ---
validate_backlog

# --- Auth pre-check: don't kick off Claude workers if auth is down ---
# Uses shared check_claude_auth which auto-triggers auth-refresh on failure
# Idempotent source — auth-check.sh has re-source guard
source "$SCRIPTS_DIR/auth-check.sh"
agent_auth_ok=false
claude_auth_ok=false
if check_claude_auth; then
  claude_auth_ok=true
  agent_auth_ok=true
  # OPS-P2-5: Clean up token expiry sentinel on successful auth (e.g. after refresh)
  rm -f "/tmp/skynet-${SKYNET_PROJECT_NAME}-token-expiry-alert" 2>/dev/null || true
fi

# Also check Codex auth (non-blocking — just sets fail flag for awareness)
_codex_auth_ok=false
if check_codex_auth; then
  _codex_auth_ok=true
  agent_auth_ok=true
  # OPS-P2-5: Clean up codex token expiry sentinel on successful auth
  rm -f "/tmp/skynet-${SKYNET_PROJECT_NAME}-codex-expiry-alert" 2>/dev/null || true
fi

# --- Token expiry pre-warning ---
# Check Claude and Codex token expiry. Alert once if within 24h.
# Sentinel files use restrictive permissions to prevent local tampering.
# NOTE: OPENAI_API_KEY has no JWT expiry mechanism — it's a static key that
# doesn't expire. Gemini tokens also lack a standard JWT exp field. Only
# Claude (OAuth) and Codex (OAuth via ~/.codex/auth.json) support pre-warning.
_expiry_sentinel="/tmp/skynet-${SKYNET_PROJECT_NAME}-token-expiry-alert"
if $claude_auth_ok && [ -f "$SKYNET_AUTH_TOKEN_CACHE" ]; then
  _claude_expiry=$(_check_token_expiry "$SKYNET_AUTH_TOKEN_CACHE" 86400)
  case "$_claude_expiry" in
    expired)
      log "Claude token expired (detected via JWT exp)"
      ;;
    warning:*)
      _hours="${_claude_expiry#warning:}"
      if [ ! -f "$_expiry_sentinel" ]; then
        log "Claude token expires in ${_hours}h — consider refreshing"
        tg "⚠️ *$SKYNET_PROJECT_NAME_UPPER*: Claude token expires in ${_hours}h. Run auth-refresh soon."
        (umask 077; touch "$_expiry_sentinel")
      fi
      ;;
    ok:*)
      rm -f "$_expiry_sentinel" 2>/dev/null || true
      ;;
  esac
fi

# Codex OAuth token expiry check (only when using auth.json, not OPENAI_API_KEY)
_codex_expiry_sentinel="/tmp/skynet-${SKYNET_PROJECT_NAME}-codex-expiry-alert"
_codex_auth_file="${SKYNET_CODEX_AUTH_FILE:-$HOME/.codex/auth.json}"
if $_codex_auth_ok && [ -z "${OPENAI_API_KEY:-}" ] && [ -f "$_codex_auth_file" ]; then
  # Extract id_token or access_token from Codex auth.json for expiry check
  _codex_token=""
  if command -v python3 >/dev/null 2>&1; then
    _codex_token=$(python3 -c "
import json, sys
try:
  d = json.load(open(sys.argv[1]))
  t = d.get('tokens', {})
  print(t.get('id_token', '') or t.get('access_token', ''))
except: pass
" "$_codex_auth_file" 2>/dev/null || true)
  fi
  if [ -n "$_codex_token" ]; then
    _codex_expiry=$(_check_token_expiry "$_codex_token" 86400)
    case "$_codex_expiry" in
      expired)
        log "Codex token expired (detected via JWT exp)"
        ;;
      warning:*)
        _hours="${_codex_expiry#warning:}"
        if [ ! -f "$_codex_expiry_sentinel" ]; then
          log "Codex token expires in ${_hours}h — consider re-authenticating"
          tg "⚠️ *$SKYNET_PROJECT_NAME_UPPER*: Codex token expires in ${_hours}h. Run codex login to refresh."
          (umask 077; touch "$_codex_expiry_sentinel")
        fi
        ;;
      ok:*)
        rm -f "$_codex_expiry_sentinel" 2>/dev/null || true
        ;;
    esac
  fi
fi

# Count backlog tasks (prefer SQLite, fallback to grep)
if [ -n "${_active_mission_slug:-}" ]; then
  backlog_count=$(db_count_pending_for_mission "$_active_mission_slug" 2>/dev/null || echo 0)
else
  backlog_count=$(db_count_pending 2>/dev/null || grep -c '^\- \[ \]' "$BACKLOG" 2>/dev/null || echo 0)
fi
backlog_count=${backlog_count:-0}
backlog_count=$((backlog_count + 0))

# Count pending failed tasks
failed_pending=$(db_count_by_status "failed" 2>/dev/null || grep -c '| pending |' "$FAILED" 2>/dev/null || echo 0)
failed_pending=${failed_pending:-0}
failed_pending=$((failed_pending + 0))

# Check worker states dynamically
dev_workers_running=0
for _wid in $(seq 1 "${SKYNET_MAX_WORKERS:-4}"); do
  is_running "${SKYNET_LOCK_PREFIX}-dev-worker-${_wid}.lock" && dev_workers_running=$((dev_workers_running + 1))
done

fixers_running=0
is_running "${SKYNET_LOCK_PREFIX}-task-fixer.lock" && fixers_running=$((fixers_running + 1))
for _fid in $(seq 2 "${SKYNET_MAX_FIXERS:-3}"); do
  is_running "${SKYNET_LOCK_PREFIX}-task-fixer-${_fid}.lock" && fixers_running=$((fixers_running + 1))
done

driver_running=false
is_running "${SKYNET_LOCK_PREFIX}-project-driver-${_active_mission_slug:-global}.lock" && driver_running=true

# --- Stale heartbeat detection ---
# Dual-source design: The file-based heartbeat check below uses .dev/worker-N.heartbeat
# files, while the DB is authoritative (db_get_stale_heartbeats / db_get_hung_workers).
# Both sources are checked intentionally as defense-in-depth:
#   - File-based: catches cases where the DB write fails or the worker process is
#     stuck in a way that prevents DB updates (e.g., SQLITE_BUSY timeout, disk full).
#   - DB-based: provides the authoritative view with richer metadata (progress_epoch
#     for hung worker detection) and is used by the dashboard/CLI for health scoring.
# The two sources may drift (e.g., heartbeat file updated but DB write failed, or
# vice versa). This is acceptable — the file check acts as a safety net, and the
# worst case is a redundant kill of an already-dead worker.
# If a worker is alive but its heartbeat is older than SKYNET_STALE_MINUTES,
# it's stuck. Kill it, unclaim its task, remove worktree, reset to idle.
_handle_stale_worker() {
  local wid="$1"
  local hb_file="$DEV_DIR/worker-${wid}.heartbeat"
  local lockfile="${SKYNET_LOCK_PREFIX}-dev-worker-${wid}.lock"
  local task_file="$DEV_DIR/current-task-${wid}.md"
  local worktree="${WORKTREE_BASE}/w${wid}"
  local stale_seconds=$(( ${SKYNET_STALE_MINUTES:-45} * 60 ))

  # Only check if heartbeat file exists (worker is actively executing a task)
  [ -f "$hb_file" ] || return 0

  local hb_epoch
  hb_epoch=$(cat "$hb_file" 2>/dev/null || echo 0)
  local now_epoch
  now_epoch=$(date +%s)
  local hb_age=$(( now_epoch - hb_epoch ))

  # OPS-R21-P1-3: When heartbeat is degraded (clock skew), use progress_epoch
  # as the primary staleness signal — heartbeat timestamps are unreliable.
  local _hb_degraded=false
  if [ -f "${hb_file}.degraded" ]; then
    _hb_degraded=true
    local _prog_epoch
    _prog_epoch=$(_db "SELECT COALESCE(progress_epoch, 0) FROM workers WHERE id=$wid;" 2>/dev/null || echo "0")
    if [ -n "$_prog_epoch" ] && [ "$_prog_epoch" -gt 0 ]; then
      hb_age=$(( now_epoch - _prog_epoch ))
      log "Worker $wid heartbeat degraded (clock skew), using progress_epoch for staleness (age=${hb_age}s)"
    fi
  fi

  if [ "$hb_age" -gt "$stale_seconds" ]; then
    # Defense-in-depth: heartbeat file mtime has 1-second granularity, and the
    # heartbeat writes every 60s. Before declaring a worker stale based solely on
    # file age, also verify the worker PID is actually dead. If the PID is alive,
    # the worker may just be slow to write its heartbeat (e.g., disk I/O stall).
    local wpid_check=""
    if [ -d "$lockfile" ] && [ -f "$lockfile/pid" ]; then
      wpid_check=$(cat "$lockfile/pid" 2>/dev/null || echo "")
    elif [ -f "$lockfile" ]; then
      wpid_check=$(cat "$lockfile" 2>/dev/null || echo "")
    fi
    if [ -n "$wpid_check" ] && kill -0 "$wpid_check" 2>/dev/null; then
      log "Worker $wid heartbeat is stale ($((hb_age / 60))m) but PID $wpid_check is alive — skipping kill"
      return 0
    fi

    local age_min=$(( hb_age / 60 ))
    log "STALE WORKER $wid: heartbeat is ${age_min}m old (threshold: ${SKYNET_STALE_MINUTES}m). Killing."

    # Kill the worker process (supports both dir-based and file-based locks)
    local wpid=""
    if [ -d "$lockfile" ] && [ -f "$lockfile/pid" ]; then
      wpid=$(cat "$lockfile/pid" 2>/dev/null || echo "")
    elif [ -f "$lockfile" ]; then
      wpid=$(cat "$lockfile" 2>/dev/null || echo "")
    fi
    if [ -n "$wpid" ] && kill -0 "$wpid" 2>/dev/null; then
      kill "$wpid" 2>/dev/null || true
      sleep 2
      kill -9 "$wpid" 2>/dev/null || true
      log "Killed worker $wid (PID $wpid)"
    fi
    rm -rf "$lockfile"

    # Unclaim its task in backlog
    local task_title=""
    if [ -f "$task_file" ]; then
      task_title=$(grep "^##" "$task_file" | head -1 | sed 's/^## //')
    fi
    if [ -n "$task_title" ]; then
      db_unclaim_task_by_title "$task_title" 2>/dev/null || log "WARNING: db_unclaim_task_by_title failed for '$task_title' — task may remain stuck as claimed"
      log "Unclaimed task: $task_title"
    fi

    # Remove the worktree
    cd "$PROJECT_DIR"
    if [ -d "$worktree" ]; then
      git worktree remove "$worktree" --force 2>/dev/null || rm -rf "$worktree" 2>/dev/null || true
      git worktree prune 2>/dev/null || true
      log "Removed worktree: $worktree"
    fi

    # Reset current-task-N.md and SQLite worker status to idle
    db_set_worker_idle "$wid" "stale worker killed after ${age_min}m" 2>/dev/null || log "WARNING: db_set_worker_idle failed for worker $wid — dashboard may show stale status"
    cat > "$task_file" <<EOF
# Current Task
**Status:** idle
**Last failure:** $(date '+%Y-%m-%d %H:%M') -- ${task_title:-unknown} (stale worker killed after ${age_min}m)
EOF

    # Clean up heartbeat file
    rm -f "$hb_file"

    tg "💀 *$SKYNET_PROJECT_NAME_UPPER WATCHDOG*: Killed stale worker $wid (stuck ${age_min}m). Task unclaimed: ${task_title:-unknown}"
    emit_event "worker_killed" "Killed stale worker $wid"
  fi
}

# Check each worker for stale heartbeats
_stale_heartbeat_count=0
for _wid in $(seq 1 "${SKYNET_MAX_WORKERS:-4}"); do
  # Count stale heartbeats (for health score) before handle kills them
  _hb_file="$DEV_DIR/worker-${_wid}.heartbeat"
  if [ -f "$_hb_file" ]; then
    _hb_epoch=$(cat "$_hb_file" 2>/dev/null || echo 0)
    _hb_age=$(( $(date +%s) - _hb_epoch ))
    if [ "$_hb_age" -gt $(( ${SKYNET_STALE_MINUTES:-45} * 60 )) ]; then
      _stale_heartbeat_count=$((_stale_heartbeat_count + 1))
    fi
  fi
  _handle_stale_worker "$_wid"
done

# Detect hung workers: heartbeat is fresh (subshell alive) but main loop
# hasn't made progress in SKYNET_STALE_MINUTES. Kill these workers so
# watchdog crash recovery can unclaim their tasks.
_hung_stale_secs=$(( ${SKYNET_STALE_MINUTES:-45} * 60 ))
_hung_workers=$(db_get_hung_workers "$_hung_stale_secs" 2>/dev/null || true)
if [ -n "$_hung_workers" ]; then
  while IFS=$'\x1f' read -r _hwid _hprog _hage; do
    [ -z "$_hwid" ] && continue
    [ -z "$_hage" ] && continue
    _hw_lock="${SKYNET_LOCK_PREFIX}-dev-worker-${_hwid}.lock"
    _hw_pid=""
    if [ -d "$_hw_lock" ] && [ -f "$_hw_lock/pid" ]; then
      _hw_pid=$(cat "$_hw_lock/pid" 2>/dev/null || echo "")
    fi
    if [ -n "$_hw_pid" ] && kill -0 "$_hw_pid" 2>/dev/null; then
      log "Hung worker $_hwid detected (heartbeat OK, progress stale ${_hage}s) — killing PID $_hw_pid"
      kill -TERM "$_hw_pid" 2>/dev/null || true
      sleep 10
      kill -0 "$_hw_pid" 2>/dev/null && kill -9 "$_hw_pid" 2>/dev/null || true
      tg "⚠️ *$SKYNET_PROJECT_NAME_UPPER WATCHDOG*: Killed hung worker $_hwid (no progress for ${_hage}s)"
    fi
  done <<< "$_hung_workers"
fi

# --- Run auto-supersede before branch cleanup (so newly-superseded entries get cleaned) ---
# SQLite auto-supersede (atomic, handles normalized root matching)
_db_superseded=$(db_auto_supersede_completed 2>/dev/null || echo 0)
if [ "${_db_superseded:-0}" -gt 0 ] 2>/dev/null; then
  log "SQLite auto-superseded $_db_superseded failed task(s)"
fi

# --- Auto-supersede failed tasks whose branches are already merged to main ---
# Catches edge cases where a branch was merged but the DB wasn't updated
# (e.g., worker crash during completion phase, manual merge).
# Runs after DB-level supersede so normalized_root matches are handled first.
_auto_supersede_merged_branches() {
  # Get branches already merged into main (fast git check)
  local merged
  merged=$(git -C "$PROJECT_DIR" branch --merged "$SKYNET_MAIN_BRANCH" 2>/dev/null \
    | sed 's/^[* ]*//' | sed 's/^ *//;s/ *$//' || true)
  [ -z "$merged" ] && { echo 0; return; }

  # Get failed/fixing tasks with branches from DB (small set)
  local failed_rows
  failed_rows=$(_db_sep "SELECT id, branch FROM tasks WHERE (status='failed' OR status LIKE 'fixing-%') AND branch != '' AND branch NOT LIKE 'merged%';" 2>/dev/null || true)
  [ -z "$failed_rows" ] && { echo 0; return; }

  local count=0
  while IFS="$_DB_SEP" read -r _tid _tbranch; do
    [ -z "$_tid" ] || [ -z "$_tbranch" ] && continue
    # Check if this task's branch is in the merged list
    if echo "$merged" | grep -qxF "$_tbranch"; then
      db_supersede_task "$_tid" 2>/dev/null || true
      log "Auto-superseded task $_tid — branch $_tbranch already merged to main"
      count=$((count + 1))
    fi
  done <<< "$failed_rows"

  echo "$count"
}

_merged_superseded=$(_auto_supersede_merged_branches 2>/dev/null || echo 0)
if [ "${_merged_superseded:-0}" -gt 0 ] 2>/dev/null; then
  log "Merged-branch auto-superseded $_merged_superseded stale failed task(s)"
fi

# --- Archive old completed tasks to prevent unbounded state file growth ---
# If completed.md has >50 entries, move entries older than 7 days to
# completed-archive.md, keeping only the most recent 50 in the active file.
# NOTE: Operates on generated completed.md rather than SQLite directly.
# This is acceptable since completed.md is regenerated at merge time.
# NOTE: completed-archive.md is NOT auto-pruned — it grows monotonically.
# For projects with thousands of completed tasks, periodically truncate or
# rotate this file manually (e.g., `tail -500 completed-archive.md > tmp && mv tmp completed-archive.md`).
_archive_old_completions() {
  [ -f "$COMPLETED" ] || return 0

  local header_lines=2
  local max_entries=50
  local max_age_days=7
  local archive="$DEV_DIR/completed-archive.md"

  # Count data rows (everything after the 2-line header)
  local total_entries
  total_entries=$(tail -n +$((header_lines + 1)) "$COMPLETED" | grep -c '^|' 2>/dev/null || true)
  total_entries=${total_entries:-0}

  [ "$total_entries" -le "$max_entries" ] && return 0

  # Calculate the cutoff date (7 days ago) — works on both macOS and Linux
  local cutoff_date
  if date -v-${max_age_days}d '+%Y-%m-%d' >/dev/null 2>&1; then
    cutoff_date=$(date -v-${max_age_days}d '+%Y-%m-%d')
  else
    cutoff_date=$(date -d "${max_age_days} days ago" '+%Y-%m-%d')
  fi

  # Split entries into keep (recent or within max_age_days) and archive (old)
  local keep_lines=""
  local archive_lines=""
  local archived_count=0

  while IFS= read -r line; do
    # Extract date from first column: | 2026-02-20 | ...
    local entry_date
    entry_date=$(echo "$line" | awk -F'|' '{gsub(/^ +| +$/,"",$2); print $2}')

    # Truncate entry_date to 10 chars (YYYY-MM-DD) for safe string comparison
    entry_date="${entry_date:0:10}"
    # SH-P2-10: Skip entries with empty or malformed dates (not exactly 10 chars YYYY-MM-DD)
    # OPS-P1-3: Log a warning for malformed dates so operators notice data quality issues
    if [ ${#entry_date} -ne 10 ]; then
      log "WARNING: Skipping completed task with malformed date (got '$entry_date'): $(echo "$line" | cut -c1-120)"
      continue
    fi
    # If date is older than cutoff, mark for archival
    if [ -n "$entry_date" ] && [ "$entry_date" \< "$cutoff_date" ]; then
      archive_lines="${archive_lines}${line}
"
      archived_count=$((archived_count + 1))
    else
      keep_lines="${keep_lines}${line}
"
    fi
  done < <(tail -n +$((header_lines + 1)) "$COMPLETED" | grep '^|')

  [ "$archived_count" -eq 0 ] && return 0

  # Ensure we still keep at least max_entries (don't archive too aggressively)
  local keep_count=$((total_entries - archived_count))
  if [ "$keep_count" -lt "$max_entries" ]; then
    # Not enough old entries to archive while keeping 50 — skip
    return 0
  fi

  # Crash-safe archival: write new archive to temp file, then rename both files.
  # If we crash between renames, the worst case is archive has the old content
  # (no data loss) while completed.md still has old entries (duplicates on next
  # run are prevented by the dedup check below).

  # Build the new archive content in a temp file
  local archive_tmp="${archive}.tmp.$$"
  if [ -f "$archive" ]; then
    cp "$archive" "$archive_tmp"
  else
    head -n "$header_lines" "$COMPLETED" > "$archive_tmp"
  fi

  # Deduplicate: only append lines not already present in the archive.
  # This makes archival idempotent — if we crash after writing the archive
  # but before rewriting completed.md, re-running won't create duplicates.
  while IFS= read -r _aline; do
    [ -z "$_aline" ] && continue
    if ! grep -qF "$_aline" "$archive_tmp" 2>/dev/null; then
      printf '%s\n' "$_aline" >> "$archive_tmp"
    fi
  done <<< "$archive_lines"

  # Write new completed.md to temp file
  local completed_tmp="$COMPLETED.tmp.$$"
  head -n "$header_lines" "$COMPLETED" > "$completed_tmp"
  printf '%s' "$keep_lines" >> "$completed_tmp"

  # Rename archive first (safe — if we crash here, completed.md still has all entries)
  mv "$archive_tmp" "$archive"
  # Then rename completed.md (archive already has the old entries as backup)
  mv "$completed_tmp" "$COMPLETED"

  # Cap the archive to 1000 lines to prevent unbounded growth
  local _archive_lines
  _archive_lines=$(wc -l < "$archive" 2>/dev/null || echo 0)
  if [ "${_archive_lines:-0}" -gt 1000 ]; then
    local _archive_cap_tmp="${archive}.cap-tmp.$$"
    tail -1000 "$archive" > "$_archive_cap_tmp" && mv "$_archive_cap_tmp" "$archive"
    log "Truncated completed-archive.md from $_archive_lines to 1000 lines"
  fi

  log "Archived $archived_count completed entries older than $max_age_days days"
}

# --- Run archival before branch cleanup ---
_archive_old_completions

# --- Refresh remote tracking refs before branch cleanup ---
# Ensures git branch -r sees up-to-date remote state (prunes deleted refs).
git -C "$PROJECT_DIR" fetch --prune origin 2>/dev/null || true

# --- Cleanup merged dev/* branches older than 7 days ---
# Periodically removes dev/* branches that have been fully merged into the main
# branch and are older than 7 days. Uses `git branch -d` (not -D) for safety —
# only deletes branches whose tips are reachable from SKYNET_MAIN_BRANCH.
_cleanup_merged_dev_branches() {
  local cutoff_epoch merged_branches deleted=0
  cutoff_epoch=$(( $(date +%s) - 7 * 86400 ))  # 7 days ago

  # List local branches fully merged into the main branch, filter to dev/*
  merged_branches=$(git -C "$PROJECT_DIR" branch --merged "$SKYNET_MAIN_BRANCH" 2>/dev/null \
    | grep 'dev/' \
    | sed 's/^[* ]*//' || true)
  [ -z "$merged_branches" ] && return 0

  local current_branch
  current_branch=$(git -C "$PROJECT_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")

  while IFS= read -r branch; do
    branch=$(echo "$branch" | sed 's/^ *//;s/ *$//')
    [ -z "$branch" ] && continue
    # Never delete the current branch
    [ "$branch" = "$current_branch" ] && continue

    # Check branch age via last commit timestamp
    local branch_epoch
    branch_epoch=$(git -C "$PROJECT_DIR" log -1 --format=%ct "$branch" 2>/dev/null || echo "")
    [ -z "$branch_epoch" ] && continue

    if [ "$branch_epoch" -lt "$cutoff_epoch" ] 2>/dev/null; then
      if git -C "$PROJECT_DIR" branch -d "$branch" 2>/dev/null; then
        log "Deleted merged dev branch: $branch (older than 7 days)"
        emit_event "merged_branch_cleaned" "Cleaned merged $branch"
        deleted=$((deleted + 1))
      fi
      # Also delete remote branch if it still exists
      if git -C "$PROJECT_DIR" show-ref --verify --quiet "refs/remotes/origin/$branch" 2>/dev/null; then
        git -C "$PROJECT_DIR" push origin --delete "$branch" 2>/dev/null && {
          log "Deleted merged remote branch: $branch"
        }
      fi
    fi
  done <<< "$merged_branches"

  if [ "$deleted" -gt 0 ]; then
    git -C "$PROJECT_DIR" worktree prune 2>/dev/null || true
    log "Merged dev branch cleanup: deleted $deleted branch(es)"
  fi
}

# --- Run merged dev branch cleanup ---
_cleanup_merged_dev_branches

# --- Cleanup stale branches for resolved failed tasks ---
# Deletes local (and remote) dev/* branches for tasks in failed-tasks.md
# whose status is fixed, superseded, or blocked. Skips "merged to main"
# entries, the current branch, and branches still being worked on.
_cleanup_stale_branches() {
  [ -f "$FAILED" ] || return 0

  local current_branch
  current_branch=$(git -C "$PROJECT_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")

  local deleted=0

  # Parse failed-tasks.md table: Branch is field $4, Status is field $7 (pipe-delimited)
  while IFS='|' read -r _ _date _task branch _error _attempts status _; do
    # Trim whitespace
    branch=$(echo "$branch" | sed 's/^ *//;s/ *$//')
    status=$(echo "$status" | sed 's/^ *//;s/ *$//')

    # Only act on resolved statuses
    case "$status" in
      fixed|superseded|blocked) ;;
      *) continue ;;
    esac

    # Skip entries without a real branch (e.g. "merged to main")
    case "$branch" in dev/*|fix/*) ;; *) continue ;; esac

    # Never delete the branch we're currently on
    [ "$branch" = "$current_branch" ] && continue

    # Delete local branch if it exists
    if git -C "$PROJECT_DIR" show-ref --verify --quiet "refs/heads/$branch" 2>/dev/null; then
      git -C "$PROJECT_DIR" branch -D "$branch" 2>/dev/null && {
        log "Deleted stale local branch: $branch (status: $status)"
        emit_event "branch_cleaned" "Cleaned $branch"
        deleted=$((deleted + 1))
      }
    fi

    # Delete remote branch if it exists
    if git -C "$PROJECT_DIR" show-ref --verify --quiet "refs/remotes/origin/$branch" 2>/dev/null; then
      git -C "$PROJECT_DIR" push origin --delete "$branch" 2>/dev/null && {
        log "Deleted stale remote branch: $branch (status: $status)"
      }
    fi
  done < <(tail -n +3 "$FAILED")  # skip header + separator rows

  # Prune worktrees that may have referenced deleted branches
  if [ "$deleted" -gt 0 ]; then
    git -C "$PROJECT_DIR" worktree prune 2>/dev/null || true
    log "Stale branch cleanup: deleted $deleted branch(es)"
    tg "🧹 *$SKYNET_PROJECT_NAME_UPPER WATCHDOG*: Cleaned up $deleted stale dev branch(es)"
  fi
}

# --- Run stale branch cleanup (SQLite + file-based) ---
# SQLite-based cleanup for branches with resolved statuses
_db_cleanup_branches=$(db_get_cleanup_branches 2>/dev/null || true)
if [ -n "$_db_cleanup_branches" ]; then
  _current_branch=$(git -C "$PROJECT_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
  _db_branch_deleted=0
  while IFS= read -r _branch; do
    [ -z "$_branch" ] && continue
    [ "$_branch" = "$_current_branch" ] && continue
    case "$_branch" in dev/*|fix/*) ;; *) continue ;; esac
    if git -C "$PROJECT_DIR" show-ref --verify --quiet "refs/heads/$_branch" 2>/dev/null; then
      git -C "$PROJECT_DIR" branch -D "$_branch" 2>/dev/null && {
        log "SQLite: Deleted stale branch: $_branch"
        emit_event "branch_cleaned" "Cleaned $_branch"
        _db_branch_deleted=$((_db_branch_deleted + 1))
      }
    fi
    if git -C "$PROJECT_DIR" show-ref --verify --quiet "refs/remotes/origin/$_branch" 2>/dev/null; then
      git -C "$PROJECT_DIR" push origin --delete "$_branch" 2>/dev/null && {
        log "SQLite: Deleted stale remote branch: $_branch"
      }
    fi
  done <<< "$_db_cleanup_branches"
  if [ "$_db_branch_deleted" -gt 0 ]; then
    git -C "$PROJECT_DIR" worktree prune 2>/dev/null || true
    log "SQLite branch cleanup: deleted $_db_branch_deleted branch(es)"
  fi
fi
# Also run file-based cleanup for backward compat
_cleanup_stale_branches

# --- Delete stale remote dev/* branches from resolved failed tasks ---
# Enumerates remote dev/* branches and cross-references against failed-tasks.md
# (and SQLite) for resolved statuses (fixed/superseded). Deletes matching remote
# branches that are no longer needed. Does NOT delete branches for pending,
# blocked, or fixing-* tasks.
_cleanup_resolved_remote_branches() {
  local current_branch
  current_branch=$(git -C "$PROJECT_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")

  # Branches checked out in active worktrees — never delete these
  local worktree_branches
  worktree_branches=$(git -C "$PROJECT_DIR" worktree list --porcelain 2>/dev/null \
    | grep '^branch ' | sed 's|^branch refs/heads/||' || true)

  # Build set of resolved branches from SQLite (fixed/superseded only)
  local resolved_branches=""
  resolved_branches=$(db_get_resolved_branches 2>/dev/null || true)

  # Supplement with file-based lookup from failed-tasks.md
  if [ -f "$FAILED" ]; then
    local _file_resolved=""
    _file_resolved=$(tail -n +3 "$FAILED" | awk -F'|' '{
      gsub(/^ +| +$/, "", $4); gsub(/^ +| +$/, "", $7);
      if ($7 == "fixed" || $7 == "superseded") print $4
    }' | grep '^dev/' || true)
    if [ -n "$_file_resolved" ]; then
      if [ -n "$resolved_branches" ]; then
        resolved_branches=$(printf '%s\n%s' "$resolved_branches" "$_file_resolved" | sort -u)
      else
        resolved_branches=$(echo "$_file_resolved" | sort -u)
      fi
    fi
  fi

  [ -z "$resolved_branches" ] && return 0

  # Enumerate actual remote dev/* branches
  local remote_dev_branches
  remote_dev_branches=$(git -C "$PROJECT_DIR" branch -r --list 'origin/dev/*' 2>/dev/null \
    | sed 's|^ *origin/||' || true)
  [ -z "$remote_dev_branches" ] && return 0

  local deleted=0
  while IFS= read -r branch; do
    branch=$(echo "$branch" | sed 's/^ *//;s/ *$//')
    [ -z "$branch" ] && continue

    # Never delete the current branch
    [ "$branch" = "$current_branch" ] && continue

    # Never delete branches in active worktrees
    echo "$worktree_branches" | grep -qxF "$branch" && continue

    # Only delete if branch is in the resolved set
    echo "$resolved_branches" | grep -qxF "$branch" || continue

    git -C "$PROJECT_DIR" push origin --delete "$branch" 2>/dev/null && {
      log "Deleted resolved remote branch: $branch"
      emit_event "resolved_branch_cleaned" "Cleaned resolved remote $branch"
      deleted=$((deleted + 1))
    }
  done <<< "$remote_dev_branches"

  if [ "$deleted" -gt 0 ]; then
    log "Resolved remote branch cleanup: deleted $deleted branch(es)"
    tg "🧹 *$SKYNET_PROJECT_NAME_UPPER WATCHDOG*: Cleaned up $deleted resolved remote dev branch(es)" 2>/dev/null || true
  fi
}

# --- Run resolved remote branch cleanup ---
_cleanup_resolved_remote_branches

# --- Cleanup orphaned dev/* branches from failed/abandoned task attempts ---
# Catches branches missed by the above cleanups: failed tasks that were never
# retried, branches from crashed workers with no DB record, and stale remote
# branches with no local counterpart. Only deletes branches older than
# SKYNET_ORPHAN_BRANCH_AGE_DAYS (default 3) that have no active worktree
# and no active task in the database.
_cleanup_orphaned_dev_branches() {
  local age_days="${SKYNET_ORPHAN_BRANCH_AGE_DAYS:-3}"
  local cutoff_epoch deleted=0
  cutoff_epoch=$(( $(date +%s) - age_days * 86400 ))

  local current_branch
  current_branch=$(git -C "$PROJECT_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")

  # Branches checked out in active worktrees — never delete these
  local worktree_branches
  worktree_branches=$(git -C "$PROJECT_DIR" worktree list --porcelain 2>/dev/null \
    | grep '^branch ' | sed 's|^branch refs/heads/||' || true)

  # Branches with active tasks (pending, claimed, fixing-*) — never delete these
  local active_branches
  active_branches=$(db_get_active_task_branches 2>/dev/null || true)

  # --- Clean orphaned LOCAL dev/* branches ---
  local all_dev_branches
  all_dev_branches=$(git -C "$PROJECT_DIR" branch 2>/dev/null \
    | grep 'dev/' | sed 's/^[* ]*//' || true)

  if [ -n "$all_dev_branches" ]; then
    while IFS= read -r branch; do
      branch=$(echo "$branch" | sed 's/^ *//;s/ *$//')
      [ -z "$branch" ] && continue
      [ "$branch" = "$current_branch" ] && continue

      # Skip if branch is in an active worktree
      echo "$worktree_branches" | grep -qxF "$branch" && continue

      # Skip if branch has an active task
      echo "$active_branches" | grep -qxF "$branch" && continue

      # Only delete if last commit is older than cutoff
      local branch_epoch
      branch_epoch=$(git -C "$PROJECT_DIR" log -1 --format=%ct "$branch" 2>/dev/null || echo "")
      [ -z "$branch_epoch" ] && continue
      [ "$branch_epoch" -ge "$cutoff_epoch" ] 2>/dev/null && continue

      if git -C "$PROJECT_DIR" branch -D "$branch" 2>/dev/null; then
        log "Deleted orphaned dev branch: $branch (no active task, older than ${age_days}d)"
        emit_event "orphan_branch_cleaned" "Cleaned orphaned $branch"
        deleted=$((deleted + 1))
      fi
      # Also delete remote if it exists
      if git -C "$PROJECT_DIR" show-ref --verify --quiet "refs/remotes/origin/$branch" 2>/dev/null; then
        git -C "$PROJECT_DIR" push origin --delete "$branch" 2>/dev/null && {
          log "Deleted orphaned remote branch: $branch"
        }
      fi
    done <<< "$all_dev_branches"
  fi

  # --- Clean stale REMOTE-ONLY dev/* branches (no local counterpart) ---
  local remote_branches
  remote_branches=$(git -C "$PROJECT_DIR" branch -r 2>/dev/null \
    | grep 'origin/dev/' | sed 's|^ *origin/||' || true)

  if [ -n "$remote_branches" ]; then
    while IFS= read -r branch; do
      branch=$(echo "$branch" | sed 's/^ *//;s/ *$//')
      [ -z "$branch" ] && continue

      # Skip if a local branch exists (already handled above)
      git -C "$PROJECT_DIR" show-ref --verify --quiet "refs/heads/$branch" 2>/dev/null && continue

      # Skip if branch has an active task
      echo "$active_branches" | grep -qxF "$branch" && continue

      # Only delete if last commit is older than cutoff
      local branch_epoch
      branch_epoch=$(git -C "$PROJECT_DIR" log -1 --format=%ct "origin/$branch" 2>/dev/null || echo "")
      [ -z "$branch_epoch" ] && continue
      [ "$branch_epoch" -ge "$cutoff_epoch" ] 2>/dev/null && continue

      git -C "$PROJECT_DIR" push origin --delete "$branch" 2>/dev/null && {
        log "Deleted stale remote-only dev branch: $branch (older than ${age_days}d)"
        emit_event "orphan_branch_cleaned" "Cleaned remote-only $branch"
        deleted=$((deleted + 1))
      }
    done <<< "$remote_branches"
  fi

  if [ "$deleted" -gt 0 ]; then
    git -C "$PROJECT_DIR" worktree prune 2>/dev/null || true
    log "Orphaned branch cleanup: deleted $deleted branch(es)"
    tg "🧹 *$SKYNET_PROJECT_NAME_UPPER WATCHDOG*: Cleaned up $deleted orphaned dev branch(es)" 2>/dev/null || true
  fi
}

# --- Run orphaned branch cleanup ---
_cleanup_orphaned_dev_branches

# Refresh worker running state after potential kills
dev_workers_running=0
for _wid in $(seq 1 "${SKYNET_MAX_WORKERS:-4}"); do
  is_running "${SKYNET_LOCK_PREFIX}-dev-worker-${_wid}.lock" && dev_workers_running=$((dev_workers_running + 1))
done
fixers_running=0
is_running "${SKYNET_LOCK_PREFIX}-task-fixer.lock" && fixers_running=$((fixers_running + 1))
for _fid in $(seq 2 "${SKYNET_MAX_FIXERS:-3}"); do
  is_running "${SKYNET_LOCK_PREFIX}-task-fixer-${_fid}.lock" && fixers_running=$((fixers_running + 1))
done

# --- Disk space monitoring ---
# Alert if disk usage exceeds threshold (default 90%). Prevents silent failures
# when logs or SQLite fill the disk.
_check_disk_space() {
  local dev_dir="$1"
  local threshold_pct="${2:-90}"  # Alert if usage > 90%
  local usage_pct
  usage_pct=$(df -P "$dev_dir" | awk 'NR==2 {gsub(/%/,""); print $5}')
  if [ -n "$usage_pct" ] && [ "$usage_pct" -ge "$threshold_pct" ]; then
    log "WARNING: Disk usage at ${usage_pct}% (threshold: ${threshold_pct}%)"
    tg "⚠️ *${SKYNET_PROJECT_NAME_UPPER}* Disk usage at ${usage_pct}% — consider running \`skynet cleanup\`" 2>/dev/null || true
    return 1
  fi
  return 0
}
_disk_ok=true
if ! _check_disk_space "$DEV_DIR"; then
  _disk_ok=false
fi

# --- Health score alert ---
# Bash implementation of the canonical health score formula in packages/dashboard/src/lib/health.ts.
# Must stay in bash for shell-only environments. Keep weights in sync with that module.
# Mirrors the pipeline-status handler logic:
#   Start at 100, -5 per pending failed task, -10 per active blocker, -2 per stale heartbeat.
# Alerts once when score drops below threshold; clears sentinel when score recovers.
_health_score_alert() {
  local threshold="${SKYNET_HEALTH_ALERT_THRESHOLD:-50}"
  # SH-P3-3: This sentinel path is predictable (/tmp/skynet-<project>-health-alert-sent).
  # On shared hosts another user could pre-create this file to suppress health alerts.
  # Mitigation: SKYNET_LOCK_PREFIX already namespaces to the project; on shared hosts,
  # operators should set SKYNET_LOCK_PREFIX to a user-private directory (e.g., under $HOME).
  local sentinel="/tmp/skynet-${SKYNET_PROJECT_NAME:-skynet}-health-alert-sent"

  # Prefer SQLite health score, fallback to file-based calculation
  local score _score_source="sqlite"
  local pending_failed=0 active_blockers=0
  score=$(db_get_health_score 2>/dev/null || echo "")
  if [ -n "$score" ]; then
    # Query component counts for logging when alert fires
    pending_failed=$(_db "SELECT COUNT(*) FROM tasks WHERE status='failed';" 2>/dev/null || echo 0)
    active_blockers=$(_db "SELECT COUNT(*) FROM blockers WHERE status='active';" 2>/dev/null || echo 0)
  fi
  if [ -z "$score" ]; then
    _score_source="file"
    score=100
    # -5 per pending failed task
    local pending_failed=0
    if [ -f "$FAILED" ]; then
      pending_failed=$(grep -c '| pending |' "$FAILED" 2>/dev/null || true)
      pending_failed=${pending_failed:-0}
    fi
    score=$((score - pending_failed * 5))

    # -10 per active blocker
    local active_blockers=0
    if [ -f "$BLOCKERS" ]; then
      local active_section
      active_section=$(awk '/^## Active/{found=1; next} /^## /{found=0} found{print}' "$BLOCKERS" 2>/dev/null || true)
      if [ -n "$active_section" ]; then
        active_blockers=$(echo "$active_section" | grep -c '^- ' 2>/dev/null || true)
        active_blockers=${active_blockers:-0}
      fi
    fi
    score=$((score - active_blockers * 10))

    # -2 per stale heartbeat
    score=$((score - _stale_heartbeat_count * 2))

    # NOTE: file-based fallback omits staleTasks24h deduction (-1 per task in_progress >24h)
    # The SQLite path (db_get_health_score) includes this via julianday comparison.

    [ "$score" -lt 0 ] && score=0
    [ "$score" -gt 100 ] && score=100
  fi

  if [ "$score" -lt "$threshold" ]; then
    # Only alert once per drop (sentinel prevents repeated alerts)
    if [ ! -f "$sentinel" ]; then
      emit_event "health_alert" "Health score: $score"
      tg "🚨 *$SKYNET_PROJECT_NAME_UPPER WATCHDOG*: Pipeline health alert: score $score/100 (threshold: $threshold)"
      (umask 077; date +%s > "$sentinel")
      log "Health alert: score $score/100 [${_score_source}] (pending_failed=$pending_failed, blockers=$active_blockers, stale_hb=$_stale_heartbeat_count)"
    fi
  else
    # Score recovered — clear sentinel so future drops will alert again
    if [ -f "$sentinel" ]; then
      rm -f "$sentinel"
      log "Health score recovered: $score/100 (threshold: $threshold). Alert cleared."
    fi
  fi
}
_health_score_alert

# --- Periodic smoke check (if enabled) ---
# If main is broken (server returns errors), pause pipeline to prevent cascading failures.
# Uses 2-strike rule: first failure sets sentinel, second consecutive failure pauses.
if [ "${SKYNET_POST_MERGE_SMOKE:-false}" = "true" ]; then
  _smoke_fail_sentinel="/tmp/skynet-${SKYNET_PROJECT_NAME:-skynet}-smoke-fail"
  _smoke_auto_pause_sentinel="/tmp/skynet-${SKYNET_PROJECT_NAME:-skynet}-smoke-auto-paused"
  if ! bash "$SKYNET_SCRIPTS_DIR/post-merge-smoke.sh" >> "$LOG" 2>&1; then
    if [ -f "$_smoke_fail_sentinel" ]; then
      # Second consecutive failure — pause pipeline
      if [ ! -f "$DEV_DIR/pipeline-paused" ]; then
        log "SMOKE CHECK: 2 consecutive failures — pausing pipeline"
        touch "$DEV_DIR/pipeline-paused"
        touch "$_smoke_auto_pause_sentinel"
        tg "🚨 *$SKYNET_PROJECT_NAME_UPPER WATCHDOG*: Pipeline auto-paused — main branch failing smoke tests"
        emit_event "pipeline_paused" "Auto-paused: smoke test failing on main"
      fi
    else
      log "SMOKE CHECK: first failure — will pause on next failure"
      (umask 077; date +%s > "$_smoke_fail_sentinel")
    fi
  else
    # Smoke passed — clear sentinel and auto-unpause if we were the ones who paused
    if [ -f "$_smoke_fail_sentinel" ]; then
      rm -f "$_smoke_fail_sentinel"
      log "SMOKE CHECK: passed — cleared failure sentinel"
    fi
    if [ -f "$_smoke_auto_pause_sentinel" ] && [ -f "$DEV_DIR/pipeline-paused" ]; then
      rm -f "$DEV_DIR/pipeline-paused" "$_smoke_auto_pause_sentinel"
      log "SMOKE CHECK: pipeline auto-unpaused — smoke tests passing again"
      tg "✅ *$SKYNET_PROJECT_NAME_UPPER WATCHDOG*: Pipeline auto-unpaused — smoke tests passing"
      emit_event "pipeline_resumed" "Auto-unpaused: smoke tests passing"
    fi
  fi
fi

# ── Canary deployment gating ───────────────────────────────────────
# NOTE: Entering canary mode does NOT kill already-running workers.
# They continue with the previous code until they complete or are detected
# as stale by the heartbeat monitor. This is intentional — killing a
# mid-merge worker could leave main in an inconsistent state.
_canary_active=false
_canary_file="${DEV_DIR}/canary-pending"
_canary_commit=""

if [ "${SKYNET_CANARY_ENABLED:-false}" = "true" ] && [ -f "$_canary_file" ]; then
  _canary_active=true
  _canary_commit=$(grep '^commit=' "$_canary_file" 2>/dev/null | cut -d= -f2)
  # Validate commit hash — must be at least 7 hex chars to prevent injection via git revert
  case "$_canary_commit" in
    [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]*) ;;
    *) log "CANARY: Invalid commit hash — skipping revert"; _canary_active=false ;;
  esac
  _canary_ts=$(grep '^timestamp=' "$_canary_file" 2>/dev/null | cut -d= -f2)
  _canary_age=$(( $(date +%s) - ${_canary_ts:-0} ))
  # Sanitize _canary_age for SQL interpolation — value is from date arithmetic
  # but _canary_ts is read from a file, so validate it's a non-negative integer.
  case "$_canary_age" in ''|*[!0-9]*) _canary_age=0 ;; esac
  _canary_timeout=$(( ${SKYNET_CANARY_TIMEOUT_MINUTES:-30} * 60 ))

  # Check if canary has timed out (auto-clear to prevent pipeline stall)
  if [ "$_canary_age" -gt "$_canary_timeout" ]; then
    log "CANARY: Auto-clearing after ${SKYNET_CANARY_TIMEOUT_MINUTES}min timeout (no crash detected)"
    rm -f "$_canary_file"
    _canary_active=false
    emit_event "canary_timeout" "auto-cleared after ${_canary_age}s"
  fi

  # Check if any task completed successfully after canary commit
  if $_canary_active; then
    _post_canary_completed=$(_db "
      SELECT COUNT(*) FROM tasks
      WHERE status IN ('completed','fixed')
        AND completed_at > datetime('now', '-${_canary_age} seconds');
    " 2>/dev/null || echo 0)
    if [ "${_post_canary_completed:-0}" -gt 0 ]; then
      log "CANARY: Validated — $_post_canary_completed task(s) completed after canary commit"
      rm -f "$_canary_file"
      _canary_active=false
      emit_event "canary_validated" "commit=$_canary_commit tasks_completed=$_post_canary_completed"
    fi
  fi

  # LIMITATION: Canary validation only monitors worker 1. If worker 1 is idle
  # while other workers run with the new code, canary validation may not trigger.
  # Future enhancement: iterate all workers (1..SKYNET_MAX_WORKERS), check if any
  # have a heartbeat newer than the canary commit timestamp, and validate against
  # whichever worker is actually running post-canary code.
  # Check for canary worker crash (dead PID + stale heartbeat)
  if $_canary_active; then
    _stale_in_canary=$(db_get_stale_heartbeats 300 1 | head -1)  # 5min, worker 1 only
    if [ -n "$_stale_in_canary" ]; then
      log "CANARY FAILED: Worker crashed during canary validation"
      log "CANARY: Auto-reverting commit $_canary_commit"
      # Attempt to revert the canary commit — hold merge lock to avoid conflicts
      if acquire_merge_lock; then
        if git revert --no-edit --no-verify "$_canary_commit" 2>/dev/null; then
          git_push_with_retry || log "WARNING: push of canary revert failed"
          log "CANARY: Reverted commit $_canary_commit"
          emit_event "canary_failed" "commit=$_canary_commit action=reverted"
        else
          log "CANARY: Auto-revert failed — manual intervention required"
          emit_event "canary_failed" "commit=$_canary_commit action=revert_failed"
        fi
        release_merge_lock
      else
        log "CANARY: Could not acquire merge lock for revert — will retry next cycle"
        emit_event "canary_failed" "commit=$_canary_commit action=revert_lock_contention"
      fi
      # Alert via notification
      tg "CANARY FAILED: Script changes in commit ${_canary_commit:0:8} caused worker crash. Auto-revert attempted." 2>/dev/null || true
      rm -f "$_canary_file"
      _canary_active=false
    fi
  fi
fi

# Apply canary dispatch limit
_effective_max_workers="${SKYNET_MAX_WORKERS:-4}"
if $_canary_active; then
  log "CANARY: Active — limiting dispatch to 1 worker"
  _effective_max_workers=1
  emit_event "canary_started" "commit=$_canary_commit"
fi

# Warn if excess workers are active during canary (don't kill — too aggressive)
if $_canary_active && [ "$dev_workers_running" -gt 1 ]; then
  log "CANARY WARNING: $dev_workers_running workers active during canary validation — only 1 should be running"
  tg "⚠️ *$SKYNET_PROJECT_NAME_UPPER WATCHDOG*: $dev_workers_running workers active during canary — excess workers may interfere with validation"
fi

# --- Circuit breaker: auto-pause after 3 consecutive merge failures ---
_check_circuit_breaker() {
  local recent_merges
  recent_merges=$(_db "SELECT event FROM events WHERE event IN ('task_completed','merge_conflict','task_reverted','revert_failed') ORDER BY epoch DESC LIMIT 3;" 2>/dev/null || echo "")
  if [ -z "$recent_merges" ]; then return 0; fi

  # Check if all recent merge-related events are failures
  local fail_count=0
  local total=0
  while IFS= read -r evt; do
    [ -z "$evt" ] && continue
    total=$((total + 1))
    case "$evt" in
      merge_conflict|task_reverted|revert_failed) fail_count=$((fail_count + 1)) ;;
    esac
  done <<< "$recent_merges"

  if [ "$total" -ge 3 ] && [ "$fail_count" -eq "$total" ]; then
    log "CIRCUIT BREAKER: $fail_count consecutive merge failures — auto-pausing pipeline"
    touch "$DEV_DIR/pipeline-paused"
    db_add_event "circuit_breaker" "Auto-paused after $fail_count consecutive merge failures"
    return 1
  fi
  return 0
}

# --- Pipeline pause check (skip dispatch but still run health checks above) ---
# Check circuit breaker first — it may create the pipeline-paused file
$_db_healthy && _check_circuit_breaker || true
pipeline_paused=false
if [ -f "$DEV_DIR/pipeline-paused" ]; then
  pipeline_paused=true
  log "Pipeline is paused. Skipping worker dispatch."
  # OPS-P2-2: Periodic re-notification while pipeline remains paused (every 30 min)
  _pause_sentinel="/tmp/skynet-${SKYNET_PROJECT_NAME:-skynet}-pause-notify"
  _pause_renotify=false
  if [ -f "$_pause_sentinel" ]; then
    _last_notify=$(cat "$_pause_sentinel" 2>/dev/null || echo 0)
    case "$_last_notify" in ''|*[!0-9]*) _last_notify=0 ;; esac
    _now_epoch=$(date +%s)
    if [ $((_now_epoch - _last_notify)) -ge 1800 ]; then
      _pause_renotify=true
    fi
  else
    _pause_renotify=true
  fi
  if $_pause_renotify; then
    tg "⏸ *WATCHDOG*: Pipeline is still paused. Manual intervention may be needed."
    (umask 077; date +%s > "$_pause_sentinel")
  fi
else
  # Pipeline is not paused — clean up sentinel if it exists
  rm -f "/tmp/skynet-${SKYNET_PROJECT_NAME:-skynet}-pause-notify" 2>/dev/null || true
fi

# --- Only kick Claude-dependent workers if auth is OK and DB is healthy ---
if ! $_disk_ok; then
  log "Skipping dispatch — disk space critical (>90%)"
elif ! $_db_healthy; then
  log "Skipping dispatch — DB unhealthy"
elif $agent_auth_ok && ! $pipeline_paused; then
  # Rule 1: Kick dev-workers proportional to backlog size
  # Worker N starts when backlog has >= N tasks and worker N is idle
  # Uses _effective_max_workers (canary-aware) instead of SKYNET_MAX_WORKERS
  for _wid in $(seq 1 "$_effective_max_workers"); do
    if [ "$backlog_count" -ge "$_wid" ] && ! is_running "${SKYNET_LOCK_PREFIX}-dev-worker-${_wid}.lock"; then
      log "Backlog has $backlog_count tasks (>=$_wid), worker $_wid idle. Kicking off."
      tg "👁 *WATCHDOG*: Kicking off dev-worker $_wid ($backlog_count tasks waiting)"
      if [ "${SKYNET_DRY_RUN:-false}" = "true" ]; then
        log "DRY-RUN: Would kick off dev-worker $_wid"
      else
        SKYNET_DEV_DIR="$DEV_DIR" nohup bash "$SCRIPTS_DIR/dev-worker.sh" "$_wid" >> "$SCRIPTS_DIR/dev-worker-${_wid}.log" 2>&1 &
      fi
    fi
  done

  # Rule 2: Kick task-fixers proportional to failed task count
  # Check fixer cooldown first — skip all fixers if cooling down
  # NOTE: Cooldown is global (all fixers), not per-fixer or per-task.
  # This prevents rapid retry storms but may delay fixes for unrelated tasks.
  # Future improvement: per-task or per-error-type cooldown.
  _fixer_cooldown_active=false
  if [ -f "$DEV_DIR/fixer-cooldown" ]; then
    _cooldown_ts=$(cat "$DEV_DIR/fixer-cooldown" 2>/dev/null || echo 0)
    _now_ts=$(date +%s)
    if [ $((_now_ts - _cooldown_ts)) -lt 1800 ]; then
      _fixer_cooldown_active=true
      log "Fixer cooldown active ($(( (_now_ts - _cooldown_ts) / 60 ))m of 30m elapsed). Skipping task-fixers."
    else
      # Cooldown expired — remove the file
      rm -f "$DEV_DIR/fixer-cooldown"
    fi
  fi

  # Fixer N starts when failed_pending >= N and fixer N is idle
  if ! $_fixer_cooldown_active; then
    for _fid in $(seq 1 "${SKYNET_MAX_FIXERS:-3}"); do
      if [ "$failed_pending" -ge "$_fid" ]; then
        _fixer_lock=""
        _fixer_log=""
        if [ "$_fid" = "1" ]; then
          _fixer_lock="${SKYNET_LOCK_PREFIX}-task-fixer.lock"
          _fixer_log="$SCRIPTS_DIR/task-fixer.log"
        else
          _fixer_lock="${SKYNET_LOCK_PREFIX}-task-fixer-${_fid}.lock"
          _fixer_log="$SCRIPTS_DIR/task-fixer-${_fid}.log"
        fi
        if ! is_running "$_fixer_lock"; then
          log "Failed tasks pending ($failed_pending, >=$_fid), task-fixer $_fid idle. Kicking off."
          tg "👁 *WATCHDOG*: Kicking off task-fixer $_fid ($failed_pending failed tasks)"
          if [ "${SKYNET_DRY_RUN:-false}" = "true" ]; then
            log "DRY-RUN: Would kick off task-fixer $_fid"
          else
            SKYNET_DEV_DIR="$DEV_DIR" nohup bash "$SCRIPTS_DIR/task-fixer.sh" "$_fid" >> "$_fixer_log" 2>&1 &
          fi
        fi
      fi
    done
  fi

  # Rule 3: Kick off project-driver if needed (rate-limited)
  # Skip if mission is already complete — no point generating tasks for a finished mission
  _mc_slug_safe=$(echo "${_active_mission_slug:-global}" | sed 's/[^a-zA-Z0-9]/_/g')
  _mc_sentinel="$DEV_DIR/mission-complete-${_mc_slug_safe}"
  if [ -f "$_mc_sentinel" ] && ! $driver_running; then
    log "Project-driver skipped — mission complete (sentinel: $_mc_sentinel)"
  elif ! $driver_running; then
    should_kick=false
    last_kick_file="${SKYNET_LOCK_PREFIX}-project-driver-${_active_mission_slug:-global}-last-kick"
    if [ "$backlog_count" -lt "${SKYNET_DRIVER_BACKLOG_THRESHOLD:-5}" ]; then
      should_kick=true
    elif [ ! -f "$last_kick_file" ]; then
      should_kick=true
    else
      last_kick=$(cat "$last_kick_file" 2>/dev/null || echo 0)
      now_kick=$(date +%s)
      if [ $((now_kick - last_kick)) -gt 3600 ]; then
        should_kick=true
      fi
    fi
    if $should_kick; then
      date +%s > "$last_kick_file"
      log "Project-driver idle (backlog: $backlog_count). Kicking off."
      tg "📋 *$SKYNET_PROJECT_NAME_UPPER*: Kicking off project-driver (backlog: $backlog_count tasks)${_active_mission_slug:+ (mission: $_active_mission_slug)}"
      if [ "${SKYNET_DRY_RUN:-false}" = "true" ]; then
        log "DRY-RUN: Would kick off project-driver"
      else
        if [ -n "$_active_mission_slug" ]; then
          SKYNET_DEV_DIR="$DEV_DIR" SKYNET_MISSION_SLUG="$_active_mission_slug" nohup bash "$SCRIPTS_DIR/project-driver.sh" >> "$SCRIPTS_DIR/project-driver-${_active_mission_slug}.log" 2>&1 &
        else
          SKYNET_DEV_DIR="$DEV_DIR" nohup bash "$SCRIPTS_DIR/project-driver.sh" >> "$SCRIPTS_DIR/project-driver-global.log" 2>&1 &
        fi
      fi
    fi
  fi
fi

# --- Fixer rolling stats (last 24h) ---
# Prefer SQLite, fallback to file
_db_fix_rate=$(db_get_fix_rate_24h 2>/dev/null || echo "")
if [ -n "$_db_fix_rate" ]; then
  log "Fixer stats (24h, SQLite): fix rate ${_db_fix_rate}%"
elif [ -f "$DEV_DIR/fixer-stats.log" ]; then
  _24h_ago=$(( $(date +%s) - 86400 ))
  _total_24h=0
  _success_24h=0
  while IFS='|' read -r _epoch _result _title; do
    [ -z "$_epoch" ] && continue
    case "$_epoch" in *[!0-9]*|"") continue ;; esac
    if [ "$_epoch" -ge "$_24h_ago" ] 2>/dev/null; then
      _total_24h=$((_total_24h + 1))
      [ "$_result" = "success" ] && _success_24h=$((_success_24h + 1))
    fi
  done < "$DEV_DIR/fixer-stats.log"
  if [ "$_total_24h" -gt 0 ]; then
    _rate=$(( _success_24h * 100 / _total_24h ))
    log "Fixer stats (24h): ${_success_24h}/${_total_24h} success (${_rate}%)"
  fi
fi

# --- Periodic maintenance (every 10 cycles ≈ 30 minutes) ---
# NOTE: If the cycle counter file is corrupted (e.g., concurrent write), the
# case-sanitize below resets it to 0. At worst, one maintenance cycle is skipped;
# the counter self-heals on the next cycle write.
_maint_cycle=$(cat "$_CYCLE_COUNTER_FILE" 2>/dev/null || echo 0)
# Sanitize cycle counter to numeric value
case "$_maint_cycle" in ''|*[!0-9]*) _maint_cycle=0 ;; esac
if [ $((_maint_cycle % 10)) -eq 0 ] && [ "$_maint_cycle" -gt 0 ]; then
  log "Running periodic maintenance (cycle $_maint_cycle)..."

  # OPS-P3-3: Log DB file size and WAL size for observability
  if [ -f "$DB_PATH" ]; then
    _db_size=$(du -h "$DB_PATH" 2>/dev/null | cut -f1)
    _wal_size=$(du -h "${DB_PATH}-wal" 2>/dev/null | cut -f1)
    log "DB size: ${_db_size:-unknown}, WAL: ${_wal_size:-none}"
  fi

  # (a) SQLite WAL checkpoint — prevents unbounded WAL growth
  if [ -f "$DB_PATH" ] && $_db_healthy; then
    # OPS-P0-2: Force TRUNCATE checkpoint if WAL file exceeds 100MB
    _wal_path="${DB_PATH}-wal"
    if [ -f "$_wal_path" ]; then
      _wal_size=$(file_size "$_wal_path")
      _wal_limit=$((100 * 1024 * 1024))  # 100MB
      if [ "${_wal_size:-0}" -gt "$_wal_limit" ] 2>/dev/null; then
        log "WARNING: WAL file is ${_wal_size} bytes (>100MB) — forcing TRUNCATE checkpoint"
        # P0-2: Wrap with timeout to prevent indefinite hang on sqlite3 lock-up
        _wal_trunc_rc=0
        run_with_timeout 10 sqlite3 "$DB_PATH" "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null 2>&1 || _wal_trunc_rc=$?
        if [ "$_wal_trunc_rc" -eq 124 ] 2>/dev/null || [ "$_wal_trunc_rc" -eq 142 ] 2>/dev/null; then
          log "WARNING: WAL checkpoint(TRUNCATE) timed out after 10s"
          emit_event "db_wal_checkpoint_failed" "TRUNCATE checkpoint timed out — WAL is ${_wal_size} bytes"
          _db_wal_healthy=false
          _db_wal_checkpoint_failures=$((_db_wal_checkpoint_failures + 1))
          echo "$(date +%s)" > "$DEV_DIR/db-wal-unhealthy" 2>/dev/null || true
        elif [ "$_wal_trunc_rc" -ne 0 ]; then
          log "CRITICAL: TRUNCATE checkpoint failed on oversized WAL"
          emit_event "db_wal_checkpoint_failed" "TRUNCATE checkpoint failed — WAL is ${_wal_size} bytes"
          _db_wal_healthy=false
          _db_wal_checkpoint_failures=$((_db_wal_checkpoint_failures + 1))
          # P0-2: Write sentinel file so dashboard can detect WAL degradation
          echo "$(date +%s)" > "$DEV_DIR/db-wal-unhealthy" 2>/dev/null || true
        fi
      fi
    fi

    # OPS-P0-2: Capture checkpoint result with circuit-breaker observability.
    # On failure, log CRITICAL and emit event so operators are alerted.
    # On success, reset the WAL health flag.
    # P0-2: Wrap with timeout to prevent indefinite hang on sqlite3 lock-up.
    # Capture exit code before || to detect timeout (124/142) vs normal failure.
    _wal_restart_rc=0
    _wal_result=$(run_with_timeout 10 sqlite3 "$DB_PATH" "PRAGMA wal_checkpoint(RESTART);" 2>/dev/null) || _wal_restart_rc=$?
    if [ "$_wal_restart_rc" -eq 124 ] 2>/dev/null || [ "$_wal_restart_rc" -eq 142 ] 2>/dev/null; then
      log "WARNING: WAL checkpoint(RESTART) timed out after 10s"
      emit_event "db_wal_checkpoint_failed" "WAL checkpoint(RESTART) timed out after 10s"
      _db_wal_healthy=false
      _db_wal_checkpoint_failures=$((_db_wal_checkpoint_failures + 1))
      if [ "$_db_wal_checkpoint_failures" -ge 3 ]; then
        log "CRITICAL: WAL checkpoint failed $_db_wal_checkpoint_failures consecutive cycles. New task claims are BLOCKED. Run: sqlite3 $DB_PATH 'PRAGMA wal_checkpoint(TRUNCATE);' to recover, or restart the pipeline."
        emit_event "db_wal_circuit_breaker_open" "WAL checkpoint timed out $_db_wal_checkpoint_failures consecutive cycles — claims blocked"
      fi
      echo "$(date +%s)" > "$DEV_DIR/db-wal-unhealthy" 2>/dev/null || true
    elif [ -n "$_wal_result" ]; then
      log "WAL checkpoint: $_wal_result"
      # P0-WAL: Detect recovery — if breaker was open, emit recovery event
      if [ "$_db_wal_checkpoint_failures" -ge 3 ]; then
        log "WAL checkpoint recovered after $_db_wal_checkpoint_failures consecutive failures — circuit breaker CLOSED, task claims resumed"
        emit_event "db_wal_circuit_breaker_closed" "WAL recovered after $_db_wal_checkpoint_failures failures"
      fi
      _db_wal_healthy=true
      _db_wal_checkpoint_failures=0
      # P0-2: Clear sentinel file on recovery
      rm -f "$DEV_DIR/db-wal-unhealthy" 2>/dev/null || true
    else
      log "CRITICAL: WAL checkpoint(RESTART) failed — database may be degraded"
      emit_event "db_wal_checkpoint_failed" "WAL checkpoint failed — database may be degraded"
      _db_wal_healthy=false
      _db_wal_checkpoint_failures=$((_db_wal_checkpoint_failures + 1))
      # P0-WAL: Open circuit breaker when threshold reached
      if [ "$_db_wal_checkpoint_failures" -ge 3 ]; then
        log "CRITICAL: WAL checkpoint failed $_db_wal_checkpoint_failures consecutive cycles. New task claims are BLOCKED. Run: sqlite3 $DB_PATH 'PRAGMA wal_checkpoint(TRUNCATE);' to recover, or restart the pipeline."
        emit_event "db_wal_circuit_breaker_open" "WAL checkpoint failed $_db_wal_checkpoint_failures consecutive cycles — claims blocked"
      fi
      # P0-2: Write sentinel file so dashboard can detect WAL degradation
      echo "$(date +%s)" > "$DEV_DIR/db-wal-unhealthy" 2>/dev/null || true
    fi
    # Run PRAGMA optimize to keep query planner statistics up-to-date
    _db "PRAGMA optimize;" 2>/dev/null || true
    # Prune events older than 7 days to prevent unbounded table growth
    db_prune_old_events 7
    # Prune fixer_stats older than 90 days to prevent unbounded table growth
    db_prune_old_fixer_stats 90
    # Archive resolved failed tasks (fixed/superseded/blocked) older than 7 days
    db_archive_resolved_failures 7

    # OPS-P0-2: Periodic disk space check
    _db_check_disk_space || log "WARNING: Disk space below threshold — DB writes may fail"
  fi

  # (b) Stale worktree cleanup — remove worktrees with no corresponding worker lock
  if [ -d "${WORKTREE_BASE:-}" ]; then
    _maint_cleaned=0
    for _maint_wt in "$WORKTREE_BASE"/*/; do
      [ -d "$_maint_wt" ] || continue
      _maint_wt_name=$(basename "$_maint_wt")
      _maint_has_lock=false
      case "$_maint_wt_name" in
        w[0-9]*)
          _maint_wid="${_maint_wt_name#w}"
          is_running "${SKYNET_LOCK_PREFIX}-dev-worker-${_maint_wid}.lock" && _maint_has_lock=true
          ;;
        fixer-[0-9]*)
          _maint_fid="${_maint_wt_name#fixer-}"
          if [ "$_maint_fid" = "1" ]; then
            is_running "${SKYNET_LOCK_PREFIX}-task-fixer.lock" && _maint_has_lock=true
          else
            is_running "${SKYNET_LOCK_PREFIX}-task-fixer-${_maint_fid}.lock" && _maint_has_lock=true
          fi
          ;;
      esac
      if ! $_maint_has_lock; then
        cd "$PROJECT_DIR"
        git worktree remove "$_maint_wt" --force 2>/dev/null || rm -rf "$_maint_wt" 2>/dev/null || true
        _maint_cleaned=$((_maint_cleaned + 1))
      fi
    done
    if [ "$_maint_cleaned" -gt 0 ]; then
      git -C "$PROJECT_DIR" worktree prune 2>/dev/null || true
      log "Maintenance: cleaned $_maint_cleaned stale worktree(s)"
    fi
  fi

  # (c) Cleanup orphaned .claude/worktrees/ directories
  # These are created by interactive `claude` sessions and may be abandoned.
  # Only clean up dirs older than 24 hours whose associated branch no longer exists.
  _claude_wt_base="$PROJECT_DIR/.claude/worktrees"
  if [ -d "$_claude_wt_base" ]; then
    _claude_wt_cleaned=0
    _now_epoch=$(date +%s)
    _max_age_secs=86400  # 24 hours
    for _claude_wt in "$_claude_wt_base"/*/; do
      [ -d "$_claude_wt" ] || continue
      _claude_wt_name=$(basename "$_claude_wt")
      # Check age — only clean up dirs older than 24 hours
      _claude_wt_mtime=$(file_mtime "$_claude_wt")
      [ "$_claude_wt_mtime" = "0" ] && continue
      _claude_wt_age=$(( _now_epoch - _claude_wt_mtime ))
      [ "$_claude_wt_age" -lt "$_max_age_secs" ] && continue
      # Check if the associated branch still exists
      _claude_wt_branch=""
      if [ -f "$_claude_wt/.git" ]; then
        _claude_wt_branch=$(git -C "$_claude_wt" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
      fi
      if [ -n "$_claude_wt_branch" ] && git -C "$PROJECT_DIR" show-ref --verify --quiet "refs/heads/$_claude_wt_branch" 2>/dev/null; then
        continue  # Branch still exists — skip
      fi
      # Orphaned: remove the worktree
      cd "$PROJECT_DIR"
      git worktree remove "$_claude_wt" --force 2>/dev/null || rm -rf "$_claude_wt" 2>/dev/null || true
      _claude_wt_cleaned=$((_claude_wt_cleaned + 1))
      log "Cleaned orphaned .claude/worktrees/$_claude_wt_name (age=${_claude_wt_age}s)"
    done
    if [ "$_claude_wt_cleaned" -gt 0 ]; then
      git -C "$PROJECT_DIR" worktree prune 2>/dev/null || true
      log "Maintenance: cleaned $_claude_wt_cleaned orphaned .claude/worktree(s)"
    fi
  fi

  # (d) Daily VACUUM: reclaim disk space from deleted rows.
  # Uses a sentinel file (same pattern as daily backup) to run at most once per day.
  # VACUUM rewrites the entire DB, so it's expensive — daily is sufficient.
  _vacuum_sentinel="$DEV_DIR/.db-vacuum-sentinel-$(date +%Y%m%d)"
  if [ -f "$DB_PATH" ] && $_db_healthy && [ ! -f "$_vacuum_sentinel" ]; then
    log "Running daily VACUUM on SQLite database"
    _db "VACUUM;" 2>/dev/null && {
      (umask 077; touch "$_vacuum_sentinel")
      log "Daily VACUUM completed"
    } || log "WARNING: Daily VACUUM failed"
  fi

  # (e) Git garbage collection (uses git's built-in threshold — won't run unless needed)
  git -C "$PROJECT_DIR" gc --auto 2>/dev/null || log "WARNING: git gc --auto failed"

  # (f) Temp file cleanup — remove stale skynet SQL temp files older than 60 minutes
  find /tmp -maxdepth 1 -name "skynet-sql-*" -user "$(id -u)" -mmin +60 -exec rm -f {} + 2>/dev/null || true

  # (f2) Stale .stale.PID lock directory cleanup — these are leftover from
  # atomic lock reclaim (mv + rm) when a crash occurs between the two operations.
  _stale_cleaned=0
  for _stale_dir in "${SKYNET_LOCK_PREFIX}"-*.lock.stale.*; do
    [ -d "$_stale_dir" ] || continue
    rm -rf "$_stale_dir" 2>/dev/null || true
    _stale_cleaned=$((_stale_cleaned + 1))
  done
  if [ "$_stale_cleaned" -gt 0 ]; then
    log "Maintenance: cleaned $_stale_cleaned stale lock directory(ies)"
  fi

  # (g) Stale branch cleanup — skipped here; _cleanup_merged_dev_branches()
  # already runs per-cycle (see above). No need for duplicate cleanup.

  # (h) OPS-P2-3: Prune orphaned worker/fixer branch refs left by failed worktree cleanup.
  # After pruning stale worktree refs, delete dev/worker-* and dev/fixer-* branches
  # that have no corresponding worktree directory. Cap at 20 per cycle to avoid long holds.
  git -C "$PROJECT_DIR" worktree prune 2>/dev/null || true
  _orphan_branches_deleted=0
  _orphan_branch_cap=20
  _orphan_branch_list=$(git -C "$PROJECT_DIR" branch --list 'dev/worker-*' 'dev/fixer-*' 2>/dev/null | sed 's/^[* ]*//')
  if [ -n "$_orphan_branch_list" ]; then
    while IFS= read -r _obranch; do
      [ -z "$_obranch" ] && continue
      [ "$_orphan_branches_deleted" -ge "$_orphan_branch_cap" ] && break
      # Check if any worktree is using this branch
      _obranch_has_wt=false
      if git -C "$PROJECT_DIR" worktree list --porcelain 2>/dev/null | grep -q "branch refs/heads/$_obranch\$"; then
        _obranch_has_wt=true
      fi
      if ! $_obranch_has_wt; then
        git -C "$PROJECT_DIR" branch -D "$_obranch" 2>/dev/null && {
          _orphan_branches_deleted=$((_orphan_branches_deleted + 1))
        } || true
      fi
    done <<< "$_orphan_branch_list"
  fi
  if [ "$_orphan_branches_deleted" -gt 0 ]; then
    log "Maintenance: pruned $_orphan_branches_deleted orphaned worker/fixer branch(es)"
  fi

  log "Periodic maintenance complete"
fi

# --- Adaptive interval: shorter when work is available, longer when idle ---
# NOTE: _adaptive_file path must match between this inner scope (subshell) and the
# outer scope below that reads it. Both use "/tmp/skynet-${SKYNET_PROJECT_NAME}-watchdog-interval"
# via variable interpolation from the same SKYNET_PROJECT_NAME env var.
# Adaptive interval file in /tmp uses umask 077 to prevent other users on shared
# hosts from manipulating the watchdog sleep interval (local DoS vector).
_adaptive_file="/tmp/skynet-${SKYNET_PROJECT_NAME}-watchdog-interval"
_idle_sentinel="$DEV_DIR/pipeline-idle"
_idle_notify_flag="/tmp/skynet-${SKYNET_PROJECT_NAME}-idle-notify"
if [ "${backlog_count:-0}" -gt 0 ] || [ "${failed_pending:-0}" -gt 0 ]; then
  (umask 077; echo 30 > "$_adaptive_file")
  # Work available — clear idle sentinel if it exists
  if [ -f "$_idle_sentinel" ]; then
    rm -f "$_idle_sentinel"
    rm -f "$_idle_notify_flag"
    log "Pipeline resumed — idle sentinel cleared"
    emit_event "pipeline_resumed" "Pipeline has new work (backlog: ${backlog_count:-0}, failed: ${failed_pending:-0})"
  fi
elif [ "${dev_workers_running:-0}" -gt 0 ] || [ "${fixers_running:-0}" -gt 0 ]; then
  (umask 077; echo "$WATCHDOG_INTERVAL" > "$_adaptive_file")
  # Workers still running — clear idle sentinel if it exists
  if [ -f "$_idle_sentinel" ]; then
    rm -f "$_idle_sentinel"
    rm -f "$_idle_notify_flag"
    log "Pipeline resumed — workers active, idle sentinel cleared"
    emit_event "pipeline_resumed" "Pipeline workers active (dev: ${dev_workers_running:-0}, fixers: ${fixers_running:-0})"
  fi
else
  (umask 077; echo 300 > "$_adaptive_file")
  # --- Pipeline idle detection ---
  # All queues empty and no workers running — pipeline is fully idle.
  # Distinguish mission-complete idle from regular idle for clearer messaging.
  _idle_mc_slug_safe=$(echo "${_active_mission_slug:-global}" | sed 's/[^a-zA-Z0-9]/_/g')
  _idle_mc_sentinel="$DEV_DIR/mission-complete-${_idle_mc_slug_safe}"
  _idle_is_mission_complete=false
  [ -f "$_idle_mc_sentinel" ] && _idle_is_mission_complete=true

  # Write sentinel (once) and emit event + throttled notification.
  if [ ! -f "$_idle_sentinel" ]; then
    if $_idle_is_mission_complete; then
      log "Pipeline idle — mission complete, no remaining work"
      echo "{\"idleSince\": \"$(date -u '+%Y-%m-%dT%H:%M:%SZ')\", \"epoch\": $(date +%s), \"project\": \"${SKYNET_PROJECT_NAME:-unknown}\", \"reason\": \"mission_complete\"}" > "$_idle_sentinel"
      emit_event "pipeline_idle" "Pipeline idle: mission complete, all success criteria met"
      tg "🏆 *$SKYNET_PROJECT_NAME_UPPER*: Pipeline idle — mission complete! All success criteria met, no remaining work."
    else
      log "Pipeline idle — no pending tasks, no failed tasks, no workers running"
      echo "{\"idleSince\": \"$(date -u '+%Y-%m-%dT%H:%M:%SZ')\", \"epoch\": $(date +%s), \"project\": \"${SKYNET_PROJECT_NAME:-unknown}\"}" > "$_idle_sentinel"
      emit_event "pipeline_idle" "Pipeline fully idle: backlog=0, failed=0, workers=0, fixers=0"
      tg "💤 *$SKYNET_PROJECT_NAME_UPPER*: Pipeline is idle — no pending or failed tasks, all workers stopped."
    fi
  else
    # Already idle — send periodic reminder (throttled to once per hour)
    if $_idle_is_mission_complete; then
      tg_throttled "$_idle_notify_flag" 3600 "🏆 *$SKYNET_PROJECT_NAME_UPPER*: Pipeline still idle — mission complete."
    else
      tg_throttled "$_idle_notify_flag" 3600 "💤 *$SKYNET_PROJECT_NAME_UPPER*: Pipeline still idle — no work available."
    fi
  fi
fi

) || {
  log "Watchdog cycle failed (exit $?) — will retry next cycle"
  # OPS-P1-1: Reset adaptive interval to default on cycle failure so a failed
  # cycle doesn't leave a stale (possibly very short) interval value that causes
  # rapid-fire retries of a broken cycle.
  _adaptive_file="/tmp/skynet-${SKYNET_PROJECT_NAME}-watchdog-interval"
  (umask 077; echo "$WATCHDOG_INTERVAL" > "$_adaptive_file") 2>/dev/null || true
  true
}

# Increment cycle counter (outside subshell so it persists)
_cur_cycle=$(cat "$_CYCLE_COUNTER_FILE" 2>/dev/null || echo 0)
# Sanitize cycle counter to numeric value (P2-13)
case "$_cur_cycle" in ''|*[!0-9]*) _cur_cycle=0 ;; esac
(umask 077; echo $((_cur_cycle + 1)) > "$_CYCLE_COUNTER_FILE")

# Read adaptive interval from subshell output (falls back to default).
# Guard against empty/stale reads: if cat returns empty string (slow write,
# interrupted subshell), fall back to the configured WATCHDOG_INTERVAL.
_adaptive_file="/tmp/skynet-${SKYNET_PROJECT_NAME}-watchdog-interval"
_cycle_interval="$WATCHDOG_INTERVAL"
[ -f "$_adaptive_file" ] && _cycle_interval=$(cat "$_adaptive_file" 2>/dev/null)
_cycle_interval="${_cycle_interval:-$WATCHDOG_INTERVAL}"

# Interruptible sleep: run sleep in background and `wait` for it.
# `wait` returns immediately when SIGUSR1 fires (plain `sleep` blocks signals).
# Workers send SIGUSR1 on exit so the watchdog can dispatch without delay.
_WAKEUP=false
sleep "$_cycle_interval" &
_sleep_pid=$!
wait "$_sleep_pid" 2>/dev/null || true
# Kill any leftover sleep process (SIGUSR1 wakes wait but not the child sleep)
kill "$_sleep_pid" 2>/dev/null || true
wait "$_sleep_pid" 2>/dev/null || true
if $_WAKEUP; then
  log "Woken early by worker signal (SIGUSR1) — running dispatch cycle"
  _WAKEUP=false
fi

done  # end main loop
