#!/usr/bin/env bash
# dev-worker.sh — Pick next task from backlog, implement it via Claude Code
# Flow: worktree -> implement -> quality gates (SKYNET_GATE_*) -> merge to main -> cleanup
# Uses git worktrees so multiple workers can run concurrently without conflicts.
# On failure: moves task to failed-tasks.md, then tries the NEXT task
# Supports multiple workers: pass worker ID as arg (default: 1)
#   bash dev-worker.sh      → worker 1
#   bash dev-worker.sh 2    → worker 2
set -euo pipefail

# Worker ID (positive integer)
WORKER_ID="${1:-1}"
case "$WORKER_ID" in
  ''|*[!0-9]*|0)
    echo "[W?] ERROR: Worker ID must be a positive integer (got '$WORKER_ID')" >&2
    exit 1
    ;;
esac

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_config.sh"

# SQLite is the sole source of truth — fail fast if missing
_require_db

# Resource guard: prevent runaway memory usage (default 4GB per worker).
# Uses virtual memory limit as a safety net — the OS kills the process on exceed.
# OPS-P2-7: Validate numeric and minimum threshold before applying ulimit.
_SKYNET_WORKER_MEM_LIMIT_KB="${SKYNET_WORKER_MEM_LIMIT_KB:-4194304}"  # 4 GB
case "${_SKYNET_WORKER_MEM_LIMIT_KB:-}" in
  ''|*[!0-9]*) echo "[W${WORKER_ID}] WARNING: SKYNET_WORKER_MEM_LIMIT_KB not numeric, skipping ulimit" >&2 ;;
  *) [ "$_SKYNET_WORKER_MEM_LIMIT_KB" -ge 524288 ] && ulimit -v "$_SKYNET_WORKER_MEM_LIMIT_KB" 2>/dev/null || echo "[W${WORKER_ID}] WARNING: Memory limit ${_SKYNET_WORKER_MEM_LIMIT_KB}KB too low (<512MB) or ulimit failed" >&2 ;;
esac

# Per-worker port offset to prevent dev-server collisions in multi-worker mode
WORKER_PORT=$((SKYNET_DEV_PORT + WORKER_ID - 1))
export PORT="$WORKER_PORT"
WORKER_DEV_URL="http://localhost:${WORKER_PORT}"

LOG="$LOG_DIR/dev-worker-${WORKER_ID}.log"
STALE_MINUTES="$SKYNET_STALE_MINUTES"
MAX_TASKS_PER_RUN="$SKYNET_MAX_TASKS_PER_RUN"

# One-shot mode: run a single provided task, skip backlog
if [ "${SKYNET_ONE_SHOT:-}" = "true" ]; then
  MAX_TASKS_PER_RUN=1
fi

# Shared lock dir for atomic backlog access (mkdir is atomic on all Unix)


# Per-worker task file (worker 1 → current-task-1.md, worker 2 → current-task-2.md)
WORKER_TASK_FILE="$DEV_DIR/current-task-${WORKER_ID}.md"

# One-shot mode uses a dedicated task file
if [ "${SKYNET_ONE_SHOT:-}" = "true" ]; then
  WORKER_TASK_FILE="$DEV_DIR/current-task-run.md"
fi

# Per-worker worktree directory (isolated from other workers)
# Worktrees live under .dev/worktrees/ (inside the repo) for easy cleanup.
# .gitignore excludes .dev/worktrees/ to prevent git status noise.
WORKTREE_DIR="${SKYNET_WORKTREE_BASE}/w${WORKER_ID}"

# Multi-mission: read worker's assigned mission (empty = use global backlog)
_worker_mission_slug=$(_get_worker_mission_slug "dev-worker-${WORKER_ID}")
_worker_mission_hash=""
if [ -n "$_worker_mission_slug" ] && [ -f "$MISSIONS_DIR/${_worker_mission_slug}.md" ]; then
  # Use slug as mission_hash for task filtering (matches what project-driver uses)
  _worker_mission_hash="$_worker_mission_slug"
fi

cd "$PROJECT_DIR"

log() { _log "info" "W${WORKER_ID}" "$*" "$LOG"; }

# Fail fast when configured agent plugin scripts are missing.
if ! validate_agent_plugin_files "$SKYNET_AGENT_PLUGIN"; then
  log "Missing required agent plugin script(s) for SKYNET_AGENT_PLUGIN=$SKYNET_AGENT_PLUGIN. Exiting."
  emit_event "worker_idle" "Worker $WORKER_ID: missing agent plugin scripts"
  exit 1
fi

# Format elapsed seconds as human-readable duration (e.g., "23m", "1h 12m")
format_duration() {
  local seconds=$1
  local minutes=$(( seconds / 60 ))
  if [ "$minutes" -lt 60 ]; then
    echo "${minutes}m"
  else
    local hours=$(( minutes / 60 ))
    local rem=$(( minutes % 60 ))
    if [ "$rem" -eq 0 ]; then
      echo "${hours}h"
    else
      echo "${hours}h ${rem}m"
    fi
  fi
}

# --- Heartbeat helpers ---
# Background loop writes epoch timestamp to .dev/worker-N.heartbeat every 30s
# so the watchdog can detect stuck workers even if the process is alive.
HEARTBEAT_FILE="$DEV_DIR/worker-${WORKER_ID}.heartbeat"
_heartbeat_pid=""

_start_heartbeat() {
  local _parent_pid=$$
  (
    # OPS-P0-1: Poll parent liveness every 5s so the subshell exits quickly
    # after SIGKILL, but only write heartbeat every 30s to reduce stale lock detection delay.
    local _hb_counter=0
    local _hb_last_epoch=0
    # OPS-R21-P1-3: Track consecutive clock skew events to detect degraded heartbeat
    local _hb_skew_count=0
    _hb_last_epoch=$(date +%s)
    while kill -0 "$_parent_pid" 2>/dev/null; do
      sleep 5
      _hb_counter=$((_hb_counter + 5))
      if [ "$_hb_counter" -ge 30 ]; then
        _hb_counter=0
        local _hb_now
        _hb_now=$(date +%s)
        # OPS-P2-3: Clock skew detection — if delta is negative or >5min,
        # the system clock jumped. Log a warning and reset the baseline.
        local _hb_delta=$((_hb_now - _hb_last_epoch))
        if [ "$_hb_delta" -lt 0 ] || [ "$_hb_delta" -gt 300 ]; then
          echo "[$(date '+%Y-%m-%d %H:%M:%S')] WARNING: Clock skew detected in heartbeat (delta=${_hb_delta}s) — resetting" >> "${HEARTBEAT_FILE}.skew" 2>/dev/null || true
          # SH-P2-3: Rotate .skew file to prevent unbounded growth
          local _skew_lines
          _skew_lines=$(wc -l < "${HEARTBEAT_FILE}.skew" 2>/dev/null || echo 0)
          if [ "$_skew_lines" -gt 50 ]; then
            tail -25 "${HEARTBEAT_FILE}.skew" > "${HEARTBEAT_FILE}.skew.tmp" 2>/dev/null && mv "${HEARTBEAT_FILE}.skew.tmp" "${HEARTBEAT_FILE}.skew" 2>/dev/null || rm -f "${HEARTBEAT_FILE}.skew.tmp" 2>/dev/null
          fi
          # OPS-R21-P1-3: Count consecutive skew events — mark heartbeat degraded after 5
          _hb_skew_count=$((_hb_skew_count + 1))
          if [ "$_hb_skew_count" -ge 5 ] && [ ! -f "${HEARTBEAT_FILE}.degraded" ]; then
            echo "$(date +%s)" > "${HEARTBEAT_FILE}.degraded" 2>/dev/null || true
            echo "[$(date '+%Y-%m-%d %H:%M:%S')] WARNING: Worker heartbeat degraded — 5+ clock skew events detected" >> "${HEARTBEAT_FILE}.skew" 2>/dev/null || true
          fi
        else
          # No skew this cycle — reset counter
          _hb_skew_count=0
        fi
        _hb_last_epoch=$_hb_now
        date +%s > "$HEARTBEAT_FILE"
        # Heartbeats prove the worker process is alive; progress updates must come
        # from main-loop checkpoints so the watchdog can still detect hung workers.
        db_update_heartbeat "$WORKER_ID" 2>/dev/null || true
      fi
    done
  ) &
  _heartbeat_pid=$!
  log "Heartbeat started (PID $_heartbeat_pid, file $HEARTBEAT_FILE)"
}

_stop_heartbeat() {
  if [ -n "$_heartbeat_pid" ]; then
    kill "$_heartbeat_pid" 2>/dev/null || true
    wait "$_heartbeat_pid" 2>/dev/null || true
    _heartbeat_pid=""
  fi
  rm -f "$HEARTBEAT_FILE" "${HEARTBEAT_FILE}.degraded"
}

# --- Worktree helpers (shared module) ---
# Each worker gets its own worktree directory so multiple workers can run
# on different branches without conflicting in the same working directory.
# WORKTREE_INSTALL_STRICT=true (default) — fail on install error.
# NOTE: _worktree.sh is already sourced by _config.sh; no need to re-source here.

# --- Task-type affinity scoring ---
# Computes per-tag success rates for this worker from historical data,
# then scores pending tasks to prefer types the worker succeeds at.
# Returns the task ID with the highest affinity score, or empty for FIFO fallback.
_compute_task_affinity() {
  local worker_id="$1"

  # Get per-tag success rates for this worker
  local _tag_stats
  _tag_stats=$(_db_sep "
    SELECT tag,
      SUM(CASE WHEN status IN ('completed','fixed') THEN 1 ELSE 0 END),
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END)
    FROM tasks
    WHERE worker_id = $worker_id
      AND tag IS NOT NULL AND tag != ''
      AND status IN ('completed','fixed','failed')
    GROUP BY tag;
  " 2>/dev/null) || return 0

  # No history — fall back to FIFO
  [ -z "$_tag_stats" ] && return 0

  # Build tag→score map in a temp file (bash 3.2: no associative arrays)
  local _affinity_map="/tmp/skynet-affinity-${worker_id}-$$"
  : > "$_affinity_map"
  while IFS=$'\x1f' read -r _atag _acompleted _afailed; do
    [ -z "$_atag" ] && continue
    local _atotal=$((_acompleted + _afailed))
    if [ "$_atotal" -gt 0 ]; then
      local _arate=$((100 * _acompleted / _atotal))
      echo "${_atag}|${_arate}|${_atotal}" >> "$_affinity_map"
    fi
  done <<< "$_tag_stats"

  # No valid stats computed
  if [ ! -s "$_affinity_map" ]; then
    rm -f "$_affinity_map"
    return 0
  fi

  # Get pending unblocked tasks (lightweight check — mirrors claim CTE logic)
  local _pending _aoc
  _aoc=$(_adaptive_order_clause 2>/dev/null) || _aoc="priority ASC"
  _pending=$(_db_sep "
    SELECT id, tag, priority FROM tasks
    WHERE status = 'pending'
      AND (blocked_by = '' OR blocked_by IS NULL)
    ORDER BY ${_aoc};
  " 2>/dev/null) || { rm -f "$_affinity_map"; return 0; }

  [ -z "$_pending" ] && { rm -f "$_affinity_map"; return 0; }

  # Count pending tasks — affinity only matters with multiple candidates
  local _pcount=0
  while IFS= read -r _line; do
    [ -n "$_line" ] && _pcount=$((_pcount + 1))
  done <<< "$_pending"
  if [ "$_pcount" -le 1 ]; then
    rm -f "$_affinity_map"
    return 0
  fi

  # Score each pending task: affinity rate (0-100), tiebreak by priority
  local _best_id="" _best_score=-1 _best_priority=999999
  while IFS=$'\x1f' read -r _ptid _pttag _ptpri; do
    [ -z "$_ptid" ] && continue
    local _pscore=50  # default for unknown tags
    if [ -n "$_pttag" ]; then
      local _prate
      # Match tag as a literal first field; avoid regex expansion/injection from tag text.
      _prate=$(awk -F'|' -v _tag="$_pttag" '$1 == _tag { print $2; exit }' "$_affinity_map" 2>/dev/null || true)
      if [ -n "$_prate" ]; then
        _pscore=$_prate
      fi
    fi
    # Higher score wins; on tie, lower priority number wins (higher priority)
    if [ "$_pscore" -gt "$_best_score" ] || { [ "$_pscore" -eq "$_best_score" ] && [ "$_ptpri" -lt "$_best_priority" ]; }; then
      _best_score=$_pscore
      _best_id=$_ptid
      _best_priority=$_ptpri
    fi
  done <<< "$_pending"

  rm -f "$_affinity_map"

  # Only use affinity if the best score beats the default (worker has real data for this tag)
  if [ -n "$_best_id" ] && [ "$_best_score" -gt 50 ]; then
    echo "$_best_id"
  fi
}

# Claim a specific task by ID (used by affinity scoring).
# Returns same format as db_claim_next_task: id\x1ftitle\x1ftag\x1fdescription\x1fbranch
_claim_task_by_id() {
  local worker_id="$1" task_id="$2"
  _db_sep "
    BEGIN IMMEDIATE;
    UPDATE tasks SET status = 'claimed', worker_id = $worker_id,
      claimed_at = datetime('now'), updated_at = datetime('now')
    WHERE id = $task_id AND status = 'pending';
    SELECT id, title, tag, description, branch FROM tasks
      WHERE id = $task_id AND worker_id = $worker_id AND status = 'claimed';
    COMMIT;
  "
}

# --- PID lock to prevent duplicate runs (per worker ID, mkdir-based atomic lock) ---
LOCKFILE="${SKYNET_LOCK_PREFIX}-dev-worker-${WORKER_ID}.lock"
if ! acquire_worker_lock "$LOCKFILE" "$LOG" "W${WORKER_ID}"; then
  exit 0
fi
# Track current task for cleanup on unexpected exit
_CURRENT_TASK_TITLE=""
_CURRENT_TASK_ID=""
cleanup_on_exit() {
  # Clean up any leaked _sql_exec/_sql_query temp files
  _db_cleanup_tmpfiles 2>/dev/null || true
  # Stop heartbeat writer
  _stop_heartbeat 2>/dev/null || true
  # SH-P3-2: These git abort commands run in PROJECT_DIR (the main repo checkout),
  # NOT in the worker's worktree. In normal flow they are no-ops because the main
  # repo is not mid-rebase/merge. They serve as safety nets only if the worker was
  # killed during do_merge_to_main() which operates in PROJECT_DIR. Theoretical
  # risk: if two workers share the same PROJECT_DIR and one is in cleanup while
  # another is mid-merge, these aborts could interfere. In practice each worker's
  # merge is serialized by the merge lock, so this cannot happen.
  # Ensure we're on main branch (may be on feature branch if killed during merge recovery)
  cd "$PROJECT_DIR" 2>/dev/null || true
  git rebase --abort 2>/dev/null || true
  git merge --abort 2>/dev/null || true
  git checkout "$SKYNET_MAIN_BRANCH" 2>/dev/null || true
  # Release merge lock if held
  release_merge_lock 2>/dev/null || true
  # Clean up worktree if it exists
  cleanup_worktree 2>/dev/null || true
  # Unclaim task if we were in the middle of one
  if [ -n "$_CURRENT_TASK_TITLE" ]; then
    if [ "${SKYNET_ONE_SHOT:-}" != "true" ]; then
      if [ -n "$_CURRENT_TASK_ID" ]; then
        # OPS-P2-2: Retry on failure to avoid inconsistent claim state.
        db_unclaim_task "$_CURRENT_TASK_ID" 2>/dev/null || { sleep 1; db_unclaim_task "$_CURRENT_TASK_ID" 2>/dev/null || log "WARNING: db_unclaim_task failed twice for task $_CURRENT_TASK_ID — watchdog will recover"; }
      else
        log "WARNING: Missing task id during cleanup for '$_CURRENT_TASK_TITLE' — watchdog will recover if needed"
      fi
    fi
    db_set_worker_idle "$WORKER_ID" "Unexpected exit — $_CURRENT_TASK_TITLE" 2>/dev/null || log "WARNING: db_set_worker_idle failed in cleanup — dashboard may show stale worker status"
    emit_event "worker_idle" "Worker $WORKER_ID: unexpected exit — $_CURRENT_TASK_TITLE"
    log "Unexpected exit — unclaimed task: $_CURRENT_TASK_TITLE"
  fi
  release_lock_if_owned "$LOCKFILE" "$$" 2>/dev/null || true
}
trap cleanup_on_exit EXIT
# NOTE: $LINENO in ERR trap may be relative to function/subshell scope, not the file.
trap 'log "ERR on line $LINENO: $BASH_COMMAND"; exit 1' ERR

# --- Graceful shutdown handling ---
# When SIGTERM/SIGINT is received (e.g. from `skynet stop`), set a flag so we
# can finish the current phase cleanly and exit at the next safe checkpoint.
# This prevents mid-merge kills from leaving branches in inconsistent state.
# _IN_MERGE guards against SIGTERM during git merge/rebase — if set, we defer
# the exit until the merge operation completes to avoid zombie branches.
SHUTDOWN_REQUESTED=false
_IN_MERGE=false
trap '
  SHUTDOWN_REQUESTED=true
  if $_IN_MERGE; then
    log "Shutdown signal received during merge — deferring until merge completes"
  else
    log "Shutdown signal received — will exit at next checkpoint"
  fi
' SIGTERM SIGINT

# --- Pipeline pause check ---
if [ -f "$DEV_DIR/pipeline-paused" ]; then
  log "Pipeline paused — exiting"
  exit 0
fi

# --- Claude Code auth pre-check (with alerting) ---
# Idempotent source — auth-check.sh has re-source guard
source "$SCRIPTS_DIR/auth-check.sh"
if ! check_any_auth; then
  log "No agent auth available (Claude/Codex). Skipping worker."
  exit 1
fi

# --- Ensure dev server is running with log capture ---
SERVER_LOG="$LOG_DIR/next-dev-w${WORKER_ID}.log"
SERVER_PID_FILE="$LOG_DIR/next-dev-w${WORKER_ID}.pid"
log "Worker port: $WORKER_PORT (base $SKYNET_DEV_PORT + worker $WORKER_ID - 1)"
if curl -sf "$WORKER_DEV_URL" > /dev/null 2>&1; then
  # Dev server is up on this worker's port — ensure we're tracking its PID
  if [ ! -f "$SERVER_PID_FILE" ] || ! kill -0 "$(cat "$SERVER_PID_FILE" 2>/dev/null)" 2>/dev/null; then
    server_pid=$(pgrep -f "next-server" 2>/dev/null | head -1 || true)
    if [ -n "$server_pid" ]; then
      echo "$server_pid" > "$SERVER_PID_FILE"
      log "Dev server found (PID $server_pid), log at $SERVER_LOG"
    fi
  fi
else
  # Dev server not running on worker port — start it with log capture
  log "Dev server not running on port $WORKER_PORT. Starting via start-dev.sh..."
  PORT="$WORKER_PORT" bash "$SCRIPTS_DIR/start-dev.sh" "$WORKER_ID" >> "$LOG" 2>&1 || true
  sleep 5
fi

if [ "${SKYNET_ONE_SHOT:-}" = "true" ]; then
  log "One-shot mode: task = ${SKYNET_ONE_SHOT_TASK:-}"
  tg "🚀 *$SKYNET_PROJECT_NAME_UPPER* one-shot run: ${SKYNET_ONE_SHOT_TASK:-}"
else
  remaining_count=$(db_count_pending 2>/dev/null || grep -c '^\- \[ \]' "$BACKLOG" 2>/dev/null || echo 0)
  remaining_count=${remaining_count:-0}
  tg "🚀 *$SKYNET_PROJECT_NAME_UPPER W${WORKER_ID}* starting — $remaining_count tasks in backlog"
fi

# --- Pre-flight checks: detect stale in-progress task for this worker ---
if [ "${SKYNET_ONE_SHOT:-}" != "true" ] && grep -q "in_progress" "$WORKER_TASK_FILE" 2>/dev/null; then
  last_modified=$(file_mtime "$WORKER_TASK_FILE")
  now=$(date +%s)
  age_minutes=$(( (now - last_modified) / 60 ))

  if [ "$age_minutes" -lt "$STALE_MINUTES" ]; then
    log "Task already in_progress (${age_minutes}m old). Exiting."
    exit 0
  else
    log "Stale lock detected (${age_minutes}m old). Moving to failed."
    task_title=$(grep "^##" "$WORKER_TASK_FILE" | head -1 | sed 's/^## //')
    # SQLite: fail the task if we can find its ID (only if worker-claimed, not fixer-owned)
    _stale_id=$(db_get_task_id_by_title "$task_title" 2>/dev/null || true)
    if [ -n "$_stale_id" ]; then
      _stale_status=$(_db "SELECT status FROM tasks WHERE id=$(_sql_int "$_stale_id");" 2>/dev/null || true)
      if [ "$_stale_status" = "claimed" ]; then
        db_fail_task "$_stale_id" "--" "Stale lock after ${age_minutes}m" "stale_lock" || true
      elif case "$_stale_status" in fixing-*) true ;; *) false ;; esac; then
        log "Stale lock on $task_title but task is $_stale_status (fixer handling) — skipping"
      fi
    fi
    db_export_state_files
  fi
fi

# --- Task loop ---
tasks_attempted=0
tasks_completed=0
tasks_failed=0
_one_shot_exit=0
TRACE_ID=""

while [ "$tasks_attempted" -lt "$MAX_TASKS_PER_RUN" ]; do
  tasks_attempted=$((tasks_attempted + 1))

  # Mission switch detection: if assignment/active mission changed, reset worker.
  _latest_mission_slug=$(_get_worker_mission_slug "dev-worker-${WORKER_ID}")
  if [ "${_latest_mission_slug:-}" != "${_worker_mission_slug:-}" ]; then
    log "Mission changed from '${_worker_mission_slug:-none}' to '${_latest_mission_slug:-none}' — resetting worker"
    db_set_worker_idle "$WORKER_ID" "Mission switched — resetting worker" 2>/dev/null || true
    emit_event "mission_worker_reset" "Worker $WORKER_ID: mission switched from '${_worker_mission_slug:-none}' to '${_latest_mission_slug:-none}'" 2>/dev/null || true
    break
  fi

  # Mission completion detection: if this worker's mission is complete, stop claiming tasks.
  if [ -n "${_worker_mission_slug:-}" ] && [ -f "$MISSIONS_DIR/${_worker_mission_slug}.md" ]; then
    _worker_mission_state=$(_get_mission_state "$MISSIONS_DIR/${_worker_mission_slug}.md")
    if [ "$_worker_mission_state" = "complete" ]; then
      log "Mission '${_worker_mission_slug}' is complete — no more tasks to claim. Exiting."
      db_set_worker_idle "$WORKER_ID" "Mission '${_worker_mission_slug}' complete" 2>/dev/null || true
      emit_event "worker_idle" "Worker $WORKER_ID: mission '${_worker_mission_slug}' complete — reassignment needed" 2>/dev/null || true
      tg "🏁 *$SKYNET_PROJECT_NAME_UPPER W${WORKER_ID}*: Mission '${_worker_mission_slug}' complete — worker idle, awaiting reassignment"
      break
    fi
  fi

  # Update progress epoch — proves the main loop is making forward progress
  # (distinct from heartbeat which runs in a background subshell)
  db_update_progress "$WORKER_ID" 2>/dev/null || log "WARNING: db_update_progress failed — watchdog may detect false hung worker"

  # Rotate log if it exceeds max size (prevents unbounded growth)
  rotate_log_if_needed "$LOG"

  # --- Graceful shutdown checkpoint ---
  if $SHUTDOWN_REQUESTED; then
    log "Shutdown requested, exiting cleanly"
    break
  fi

  # P0-WAL: Block claims while WAL checkpoint circuit breaker is open.
  # Sleep 30s and retry to avoid burning CPU in a tight loop.
  while ! db_is_wal_healthy; do
    log "Waiting for WAL recovery before claiming... (${_db_wal_checkpoint_failures:-unknown} consecutive failures)"
    sleep 30
    if $SHUTDOWN_REQUESTED; then
      log "Shutdown requested during WAL recovery wait"
      break 2
    fi
  done

  # Atomically claim next unchecked task (or use provided task in one-shot mode)
  if [ "${SKYNET_ONE_SHOT:-}" = "true" ]; then
    next_task="- [ ] ${SKYNET_ONE_SHOT_TASK}"
    _db_task_id=""
  else
    _db_result=""

    # --- Task-type affinity: prefer tasks matching this worker's strengths ---
    # Skip affinity for mission-filtered workers (they use a separate claim path)
    if [ -z "$_worker_mission_hash" ]; then
      _affinity_task_id=$(_compute_task_affinity "$WORKER_ID" 2>/dev/null || true)
      if [ -n "$_affinity_task_id" ]; then
        _db_result=$(_claim_task_by_id "$WORKER_ID" "$_affinity_task_id" 2>/dev/null || true)
        if [ -n "$_db_result" ]; then
          log "Affinity claim: selected task $_affinity_task_id (worker has high success rate for this type)"
        fi
      fi
    fi

    # Fall back to standard FIFO claim if affinity didn't yield a result
    if [ -z "$_db_result" ]; then
      if [ -n "$_worker_mission_hash" ]; then
        _db_result=$(db_claim_next_task_for_mission "$WORKER_ID" "$_worker_mission_hash")
      else
        _db_result=$(db_claim_next_task "$WORKER_ID")
      fi
    fi
    if [ -n "$_db_result" ]; then
      _db_task_id=$(echo "$_db_result" | cut -d$'\x1f' -f1)
      _db_title=$(echo "$_db_result" | cut -d$'\x1f' -f2)
      _db_tag=$(echo "$_db_result" | cut -d$'\x1f' -f3)
      if [ -z "$_db_title" ] || [ -z "$_db_task_id" ]; then
        log "ERROR: db_claim_next_task returned malformed result, skipping"
        continue
      fi

      # OPS-P1-3: Rate limit on task claim loops — if the same task has been
      # claimed >3 times in 5 minutes, it likely fails immediately on each attempt
      # (e.g., worktree creation fails). Skip it to avoid rapid retry storms.
      _claim_tracker="/tmp/skynet-${SKYNET_PROJECT_NAME}-claim-attempts"
      _now_epoch=$(date +%s)
      _cutoff_epoch=$((_now_epoch - 300))
      # Prune old entries and count recent claims for this task ID
      # P0-1: Wrap claim tracker read-prune-write in mkdir lock to prevent
      # concurrent workers from corrupting the file.
      _claim_lock="${_claim_tracker}.lock"
      _claim_locked=false
      _claim_skip=false
      if [ -f "$_claim_tracker" ]; then
        _claim_lock_i=0
        while [ "$_claim_lock_i" -lt 5 ]; do
          if mkdir "$_claim_lock" 2>/dev/null; then
            _claim_locked=true
            break
          fi
          _claim_lock_i=$((_claim_lock_i + 1))
          perl -e 'select(undef,undef,undef,0.1)' 2>/dev/null || sleep 1
        done
        if $_claim_locked; then
          _recent_claims=0
          _kept_lines=""
          while IFS='|' read -r _ct_epoch _ct_id; do
            [ -z "$_ct_epoch" ] && continue
            case "$_ct_epoch" in ''|*[!0-9]*) continue ;; esac
            if [ "$_ct_epoch" -ge "$_cutoff_epoch" ]; then
              _kept_lines="${_kept_lines}${_ct_epoch}|${_ct_id}
"
              if [ "$_ct_id" = "$_db_task_id" ]; then
                _recent_claims=$((_recent_claims + 1))
              fi
            fi
          done < "$_claim_tracker"
          printf '%s' "$_kept_lines" > "$_claim_tracker"
          # OPS-P1-1: Prevent claim tracker from growing unbounded.
          # Rotate to .1 backup instead of truncating to preserve data for debugging.
          if [ -f "$_claim_tracker" ]; then
            _tracker_size=0
            _tracker_size=$(wc -c < "$_claim_tracker" 2>/dev/null || echo 0)
            if [ "$_tracker_size" -gt 10240 ]; then
              mv "$_claim_tracker" "${_claim_tracker}.1" 2>/dev/null || true
              : > "$_claim_tracker"
              log "WARNING: Claim tracker exceeded 10KB — rotated to .1 backup"
            fi
          fi
          if [ "$_recent_claims" -ge 3 ]; then
            log "WARNING: Task $_db_task_id ('$_db_title') claimed $_recent_claims times in 5 min — skipping to prevent rapid retry"
            _claim_skip=true
          fi
          # Record this claim attempt (inside lock to prevent lost writes)
          if ! $_claim_skip; then
            echo "${_now_epoch}|${_db_task_id}" >> "$_claim_tracker"
          fi
          rmdir "$_claim_lock" 2>/dev/null || rm -rf "$_claim_lock" 2>/dev/null || true
        else
          # Lock contention after 5 retries — skip pruning (stale data is
          # better than corruption). Append is safe for single-line writes.
          log "WARNING: Claim tracker lock contention — skipping prune, appending only"
          echo "${_now_epoch}|${_db_task_id}" >> "$_claim_tracker"
        fi
      else
        # No tracker file yet — record this first claim attempt
        echo "${_now_epoch}|${_db_task_id}" >> "$_claim_tracker"
      fi
      if $_claim_skip; then
        db_unclaim_task "$_db_task_id" || { sleep 1; db_unclaim_task "$_db_task_id" 2>/dev/null || log "ERROR: db_unclaim_task failed twice for task $_db_task_id — watchdog will recover"; }
        continue
      fi

      next_task="- [ ] [${_db_tag}] ${_db_title}"
    else
      next_task=""
      _db_task_id=""
    fi
  fi
  if [ -z "$next_task" ]; then
    log "Backlog empty. Kicking off project-driver to refill."
    db_set_worker_idle "$WORKER_ID" "Backlog empty — project-driver kicked off" 2>/dev/null || log "WARNING: db_set_worker_idle failed — dashboard may show stale worker status"
    emit_event "worker_idle" "Worker $WORKER_ID: backlog empty"
    cat > "$WORKER_TASK_FILE" <<EOF
# Current Task
**Status:** idle
**Updated:** $(date '+%Y-%m-%d %H:%M')
**Note:** Backlog empty — project-driver kicked off to replenish
EOF
    # Kick off project-driver if not already running.
    # NOTE: -f on the pid file (not -d on the lock dir) is intentional — checking
    # the pid file implicitly confirms the mkdir-based lock directory exists AND
    # that the PID was written (vs. a crash between mkdir and pid-write).
    _pd_suffix="${_worker_mission_hash:-global}"
    if ! ([ -f "${SKYNET_LOCK_PREFIX}-project-driver-${_pd_suffix}.lock/pid" ] && kill -0 "$(cat "${SKYNET_LOCK_PREFIX}-project-driver-${_pd_suffix}.lock/pid")" 2>/dev/null); then
      if [ -n "$_worker_mission_hash" ]; then
        SKYNET_MISSION_SLUG="$_worker_mission_hash" nohup bash "$SCRIPTS_DIR/project-driver.sh" >> "$LOG_DIR/project-driver-${_pd_suffix}.log" 2>&1 &
      else
        nohup bash "$SCRIPTS_DIR/project-driver.sh" >> "$LOG_DIR/project-driver-${_pd_suffix}.log" 2>&1 &
      fi
      log "Project-driver launched (PID $!)${_worker_mission_hash:+ for mission $_worker_mission_hash}."
      tg "📋 *WATCHDOG*: Backlog empty — project-driver kicked off to replenish${_worker_mission_hash:+ (mission: $_worker_mission_hash)}"
    else
      log "Project-driver already running."
    fi
    break
  fi

  # Extract task details
  task_title=$(echo "$next_task" | sed 's/^- \[ \] //')
  _CURRENT_TASK_TITLE="$task_title"
  _CURRENT_TASK_ID="${_db_task_id:-}"
  _CURRENT_TASK_DB_TITLE="${_db_title:-$task_title}"
  # Avoid grep here because set -e + pipefail would crash the worker when no [TAG] exists.
  task_type=""
  case "$task_title" in
    \[*\]*)
      task_type="${task_title#\[}"
      task_type="${task_type%%]*}"
      ;;
  esac
  branch_name="${SKYNET_BRANCH_PREFIX}$(echo "$task_title" | sed 's/^\[[^]]*\] //' | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | tr -cd 'a-z0-9-' | sed 's/^-*//' | head -c 40)"

  # Load skills matching this task's tag
  SKILL_CONTENT="$(get_skills_for_tag "${task_type:-}")"

  # Generate trace ID for task lifecycle tracing
  TRACE_ID=$(_generate_trace_id)
  if [ -n "${_db_task_id:-}" ]; then
    db_set_trace_id "$_db_task_id" "$TRACE_ID" 2>/dev/null || true
  fi

  log "TRACE=$TRACE_ID Claimed task ${_db_task_id:-}: $task_title"
  log "Starting task ($tasks_attempted/$MAX_TASKS_PER_RUN): $task_title"
  log "Branch: $branch_name"
  tg "🔨 *$SKYNET_PROJECT_NAME_UPPER W${WORKER_ID}* starting: $task_title"
  emit_event "task_claimed" "Worker $WORKER_ID: $task_title"

  # --- Intent declaration and overlap check ---
  # Declare what code areas this task intends to modify so other workers
  # (and the dashboard) can detect potential merge conflicts early.
  db_declare_intent "$WORKER_ID" "${task_type:-}" "$task_title" 2>/dev/null || true
  _overlap=$(db_check_intent_overlap "$WORKER_ID" "${task_type:-}" "$task_title" 2>/dev/null || true)
  if [ -n "$_overlap" ]; then
    log "SKIP: Intent overlap detected — unclaiming task to avoid merge conflicts:"
    while IFS='|' read -r _ov_wid _ov_intent _ov_title; do
      [ -z "$_ov_wid" ] && continue
      log "  W${_ov_wid}: ${_ov_title} (shared: ${_ov_intent})"
    done <<< "$_overlap"
    emit_event "intent_overlap_skip" "Worker $WORKER_ID skipped ($task_title) — overlaps with: $_overlap" 2>/dev/null || true
    db_clear_intent "$WORKER_ID" 2>/dev/null || true
    [ -n "${_db_task_id:-}" ] && { db_unclaim_task "$_db_task_id" || { sleep 1; db_unclaim_task "$_db_task_id" 2>/dev/null || log "ERROR: db_unclaim_task failed twice for task $_db_task_id — watchdog will recover"; }; }
    _CURRENT_TASK_TITLE=""
    _CURRENT_TASK_ID=""
    continue
  fi

  # Write current task status for this worker
  task_start_epoch=$(date +%s)
  db_set_worker_status "$WORKER_ID" "dev" "in_progress" "${_db_task_id:-}" "$task_title" "$branch_name" 2>/dev/null || log "WARNING: db_set_worker_status failed — dashboard may show stale worker status"
  cat > "$WORKER_TASK_FILE" <<EOF
# Current Task
## $task_title
**Status:** in_progress
**Started:** $(date '+%Y-%m-%d %H:%M')
**Branch:** $branch_name
**Worker:** $WORKER_ID
EOF

  # Start heartbeat for this task (watchdog uses this to detect stuck workers)
  _start_heartbeat

  # --- Set up isolated worktree for this task ---
  if git show-ref --verify --quiet "refs/heads/$branch_name" 2>/dev/null; then
    # Branch exists from a prior failed attempt — reuse it
    if ! setup_worktree "$branch_name" false; then
      if [ "${WORKTREE_LAST_ERROR:-}" = "branch_in_use" ]; then
        log "Branch $branch_name is already checked out in another worktree — skipping for now."
        _stop_heartbeat
        [ -n "${_db_task_id:-}" ] && { db_unclaim_task "$_db_task_id" || { sleep 1; db_unclaim_task "$_db_task_id" 2>/dev/null || log "ERROR: db_unclaim_task failed twice for task $_db_task_id — watchdog will recover"; }; }
        db_export_state_files 2>/dev/null || true

        _CURRENT_TASK_TITLE=""
        _CURRENT_TASK_ID=""
        break
      fi
      log "Failed to create worktree for existing branch $branch_name — unclaiming."
      _stop_heartbeat
      cleanup_worktree "$branch_name"
      [ -n "${_db_task_id:-}" ] && { db_unclaim_task "$_db_task_id" || { sleep 1; db_unclaim_task "$_db_task_id" 2>/dev/null || log "ERROR: db_unclaim_task failed twice for task $_db_task_id — watchdog will recover"; }; }
      db_export_state_files 2>/dev/null || true

      _CURRENT_TASK_TITLE=""
      _CURRENT_TASK_ID=""
      continue
    fi
    log "Reusing existing branch $branch_name in worktree"
  else
    # Create new feature branch from main
    if ! setup_worktree "$branch_name" true; then
      if [ "${WORKTREE_LAST_ERROR:-}" = "branch_in_use" ]; then
        log "Branch $branch_name is already checked out in another worktree — skipping for now."
        _stop_heartbeat
        [ -n "${_db_task_id:-}" ] && { db_unclaim_task "$_db_task_id" || { sleep 1; db_unclaim_task "$_db_task_id" 2>/dev/null || log "ERROR: db_unclaim_task failed twice for task $_db_task_id — watchdog will recover"; }; }
        db_export_state_files 2>/dev/null || true

        _CURRENT_TASK_TITLE=""
        _CURRENT_TASK_ID=""
        break
      fi
      log "Failed to create worktree for $branch_name — unclaiming."
      _stop_heartbeat
      cleanup_worktree "$branch_name"
      [ -n "${_db_task_id:-}" ] && { db_unclaim_task "$_db_task_id" || { sleep 1; db_unclaim_task "$_db_task_id" 2>/dev/null || log "ERROR: db_unclaim_task failed twice for task $_db_task_id — watchdog will recover"; }; }
      db_export_state_files 2>/dev/null || true

      _CURRENT_TASK_TITLE=""
      _CURRENT_TASK_ID=""
      continue
    fi
  fi
  log "Worktree ready at $WORKTREE_DIR"

  # --- Build pipeline context (other workers' tasks, recent completions) ---
  PIPELINE_CONTEXT="$(_build_pipeline_context "$WORKER_ID")"

  # --- Implementation via Claude Code (runs in isolated worktree) ---
  PROMPT="You are working on the ${SKYNET_PROJECT_NAME} project at $WORKTREE_DIR.

Your task: $task_title

${SKYNET_WORKER_CONTEXT:-}${PIPELINE_CONTEXT}
${SKILL_CONTENT:+
## Project Skills

$SKILL_CONTENT
}
Instructions:
1. Read the codebase to understand existing patterns (check CLAUDE.md, existing sync code, API routes)
2. Implement the task following existing conventions
3. Run '$SKYNET_TYPECHECK_CMD' to verify no type errors -- fix any that arise (up to 3 attempts)
4. After implementing, check the dev server log for runtime errors: cat $SERVER_LOG | tail -50
   - If you see 500 errors, missing table errors, or import failures related to YOUR changes, fix them before committing
   - Also test your new API routes with curl (e.g. curl -s ${WORKER_DEV_URL}/api/your/route | head -20)
5. Stage and commit your changes to the current branch with a descriptive commit message
6. Do NOT modify any files in ${DEV_DIR##*/}/ -- those are managed by the pipeline

Debugging tools available to you:
- Server log: cat $SERVER_LOG | tail -100 (shows Next.js runtime errors, 500s, missing tables)
- Test an API route: curl -s ${WORKER_DEV_URL}/api/... | head -20
- Check if dev server is running: curl -sf ${WORKER_DEV_URL}

If you encounter a blocker you cannot resolve (missing API keys, unclear requirements, etc.):
- Write it to $BLOCKERS with the date and task name
- Do NOT commit broken code

${SKYNET_WORKER_CONVENTIONS:-}"

  # --- Dry-run mode: skip agent execution ---
  if [ "${SKYNET_DRY_RUN:-false}" = "true" ]; then
    log "DRY-RUN: Would execute agent for task: $task_title"
    log "DRY-RUN: Skipping agent execution, unclaiming task"
    [ -n "${_db_task_id:-}" ] && { db_unclaim_task "$_db_task_id" || { sleep 1; db_unclaim_task "$_db_task_id" 2>/dev/null || log "ERROR: db_unclaim_task failed twice for task $_db_task_id — watchdog will recover"; }; }
    _CURRENT_TASK_TITLE=""
    _CURRENT_TASK_ID=""
    _stop_heartbeat
    cleanup_worktree "$branch_name"
    continue
  fi

  # Per-mission LLM config: read provider/model override for this mission
  _mission_llm_provider=""
  _mission_llm_model=""
  if [ -n "${_worker_mission_slug:-}" ]; then
    _llm_info=$(_get_mission_llm_config "$_worker_mission_slug")
    _mission_llm_provider=$(echo "$_llm_info" | head -1)
    _mission_llm_model=$(echo "$_llm_info" | sed -n '2p')
    if [ -n "$_mission_llm_model" ]; then
      log "Mission LLM override: provider=${_mission_llm_provider:-auto} model=$_mission_llm_model"
    fi
  fi

  # Run agent in subshell; model override is scoped to this invocation
  (
    if [ -n "$_mission_llm_model" ]; then
      case "${_mission_llm_provider:-}" in
        claude) export SKYNET_CLAUDE_MODEL="$_mission_llm_model" ;;
        codex)  export SKYNET_CODEX_MODEL="$_mission_llm_model" ;;
        gemini) export SKYNET_GEMINI_MODEL="$_mission_llm_model" ;;
      esac
    fi
    cd "$WORKTREE_DIR" && run_agent "$PROMPT" "$LOG"
  ) && exit_code=0 || exit_code=$?
  _stop_heartbeat
  if [ "$exit_code" -eq 124 ]; then
    log "Agent timed out after ${SKYNET_AGENT_TIMEOUT_MINUTES}m"
    tg "⏰ *$SKYNET_PROJECT_NAME_UPPER W${WORKER_ID}*: Agent timed out after ${SKYNET_AGENT_TIMEOUT_MINUTES}m — $task_title"
  fi
  if [ "$exit_code" -eq 125 ]; then
    log "All agents hit usage limits (exit 125) — auto-pausing pipeline"
    tg "⏸ *$SKYNET_PROJECT_NAME_UPPER W${WORKER_ID}*: All agents hit usage limits — auto-pausing pipeline"
    emit_event "pipeline_paused" "Usage limits exhausted"
    touch "$DEV_DIR/pipeline-paused"
    cleanup_worktree "$branch_name"
    [ -n "${_db_task_id:-}" ] && { db_unclaim_task "$_db_task_id" "$WORKER_ID" 2>/dev/null || true; }
    db_set_worker_idle "$WORKER_ID" "Usage limits exhausted" 2>/dev/null || true
    _CURRENT_TASK_TITLE=""
    break
  elif [ "$exit_code" -ne 0 ]; then
    log "Claude Code FAILED (exit $exit_code): $task_title"
    tg "❌ *$SKYNET_PROJECT_NAME_UPPER W${WORKER_ID} FAILED*: $task_title (claude exit $exit_code)"
    emit_event "task_failed" "Worker $WORKER_ID: $task_title"
    tasks_failed=$((tasks_failed + 1))
    cleanup_worktree "$branch_name"
    [ -n "${_db_task_id:-}" ] && { db_fail_task "$_db_task_id" "$branch_name" "claude exit code $exit_code" "agent_failed" || log "WARNING: db_fail_task failed — task may not be recorded as failed"; }
    db_set_worker_idle "$WORKER_ID" "Last failure: $task_title (claude failed)" 2>/dev/null || log "WARNING: db_set_worker_idle failed after claude failure — dashboard may show stale status"
    emit_event "worker_idle" "Worker $WORKER_ID: claude failed — $task_title"
    _CURRENT_TASK_TITLE=""
    _CURRENT_TASK_ID=""
    _one_shot_exit=1
    cat > "$WORKER_TASK_FILE" <<EOF
# Current Task
**Status:** idle
**Last failure:** $(date '+%Y-%m-%d %H:%M') -- $task_title (claude failed)
EOF
    log "Moved to failed-tasks. Trying next..."
    continue
  fi

  # Update progress epoch after agent finishes — long runs may have staled it
  db_update_progress "$WORKER_ID" 2>/dev/null || true
  log "TRACE=$TRACE_ID Agent completed"
  log "Claude Code completed. Running checks before merge..."

  if [ ! -d "$WORKTREE_DIR" ]; then
    log "Worktree missing before gates — re-adding $branch_name"
    if ! setup_worktree "$branch_name" false; then
      log "Failed to re-add worktree for $branch_name — recording failure."
      tg "❌ *$SKYNET_PROJECT_NAME_UPPER W${WORKER_ID} FAILED*: $task_title (worktree missing)"
      emit_event "task_failed" "Worker $WORKER_ID: $task_title (worktree missing)"
      tasks_failed=$((tasks_failed + 1))
      cleanup_worktree "$branch_name"
      [ -n "${_db_task_id:-}" ] && { db_fail_task "$_db_task_id" "$branch_name" "worktree missing before gates" "worktree_missing" || log "WARNING: db_fail_task failed — task may not be recorded as failed"; }
      db_set_worker_idle "$WORKER_ID" "Last failure: $task_title (worktree missing)" 2>/dev/null || log "WARNING: db_set_worker_idle failed — dashboard may show stale worker status"
      emit_event "worker_idle" "Worker $WORKER_ID: worktree missing — $task_title"
      _CURRENT_TASK_TITLE=""
      _CURRENT_TASK_ID=""
      _one_shot_exit=1
      cat > "$WORKER_TASK_FILE" <<EOF
# Current Task
**Status:** idle
**Last failure:** $(date '+%Y-%m-%d %H:%M') -- $task_title (worktree missing)
EOF
      log "Moved to failed-tasks. Branch $branch_name kept for task-fixer."
      continue
    fi
  fi

  # --- Run configurable quality gates (in worktree) ---
  # Clean .dev/ changes Claude may have made in the worktree
  (cd "$WORKTREE_DIR" && git checkout -- "${DEV_DIR##*/}/" 2>/dev/null || true)
  (cd "$WORKTREE_DIR" && git clean -fd test-results/ 2>/dev/null || true)

  # --- Ensure dependencies are fresh before quality gates ---
  # If pnpm-lock.yaml is newer than node_modules, re-install to avoid
  # "Cannot find module" errors when new deps were added on main.
  if [ -f "$WORKTREE_DIR/pnpm-lock.yaml" ]; then
    _lock_mtime=$(file_mtime "$WORKTREE_DIR/pnpm-lock.yaml")
    _modules_mtime=$(file_mtime "$WORKTREE_DIR/node_modules/.modules.yaml")
    if [ "$_lock_mtime" -gt "$_modules_mtime" ]; then
      log "Lock file newer than node_modules — running install"
      _install_cmd="${SKYNET_INSTALL_CMD:-pnpm install --frozen-lockfile}"
      # Validate install command against allowed character set (defense-in-depth)
      case "$_install_cmd" in *".."*|*";"*|*"|"*|*'$('*|*'`'*) log "ERROR: SKYNET_INSTALL_CMD contains disallowed characters — skipping install" ;; *) (cd "$WORKTREE_DIR" && eval "$_install_cmd") >> "$LOG" 2>&1 ;; esac
    fi
  fi

  _gate_failed=""
  _gate_idx=1
  while true; do
    _gate_var="SKYNET_GATE_${_gate_idx}"
    eval "_gate_cmd=\${${_gate_var}:-}"
    if [ -z "$_gate_cmd" ]; then break; fi
    log "Running gate $_gate_idx: $_gate_cmd"
    # Safety: gate commands are validated at config time (EXECUTABLE_KEYS regex: ^[a-zA-Z0-9 .\/_:=-]+$)
    # which blocks shell metacharacters (;, &&, ||, |, $, backticks, redirects).
    if ! (cd "$WORKTREE_DIR" && eval "$_gate_cmd") >> "$LOG" 2>&1; then
      _gate_failed="$_gate_cmd"
      break
    fi
    log "Gate $_gate_idx passed."
    db_update_progress "$WORKER_ID" 2>/dev/null || true
    _gate_idx=$((_gate_idx + 1))
  done

  if [ -n "$_gate_failed" ]; then
    _gate_label=$(echo "$_gate_failed" | awk '{print $NF}')
    log "GATE FAILED: $_gate_failed. Branch NOT merged."
    tg "❌ *$SKYNET_PROJECT_NAME_UPPER W${WORKER_ID} FAILED*: $task_title ($_gate_label failed)"
    emit_event "task_failed" "Worker $WORKER_ID: $task_title (gate: $_gate_label)"
    tasks_failed=$((tasks_failed + 1))
    cleanup_worktree  # Keep branch for task-fixer
    [ -n "${_db_task_id:-}" ] && { db_fail_task "$_db_task_id" "$branch_name" "$_gate_label failed" "gate_failed" || log "WARNING: db_fail_task failed — task may not be recorded as failed"; }
    db_set_worker_idle "$WORKER_ID" "Last failure: $task_title ($_gate_label failed)" 2>/dev/null || log "WARNING: db_set_worker_idle failed — dashboard may show stale worker status"
    emit_event "worker_idle" "Worker $WORKER_ID: gate failed — $task_title"
    _CURRENT_TASK_TITLE=""
    _CURRENT_TASK_ID=""
    _one_shot_exit=1
    cat > "$WORKER_TASK_FILE" <<EOF
# Current Task
**Status:** idle
**Last failure:** $(date '+%Y-%m-%d %H:%M') -- $task_title ($_gate_label failed, branch kept)
EOF
    log "Moved to failed-tasks. Branch $branch_name kept for task-fixer."
    continue
  fi

  log "TRACE=$TRACE_ID Gates passed"
  log "All quality gates passed."

  # --- Shell syntax gate: bash -n on changed .sh files ---
  _sh_ok=true
  if _changed_sh=$(cd "$WORKTREE_DIR" && git diff --name-only "$SKYNET_MAIN_BRANCH"..."$branch_name" -- '*.sh' 2>&1); then
    if [ -n "$_changed_sh" ]; then
      log "Checking shell syntax for changed .sh files..."
      while IFS= read -r _sh_file; do
        [ -z "$_sh_file" ] && continue
        if [ -f "$WORKTREE_DIR/$_sh_file" ] && ! bash -n "$WORKTREE_DIR/$_sh_file" 2>>"$LOG"; then
          log "Shell syntax error in $_sh_file"
          _sh_ok=false
        fi
      done <<< "$_changed_sh"
    fi
  else
    log "WARNING: git diff failed for bash -n gate — skipping"
  fi
  if ! $_sh_ok; then
    _gate_failed="bash -n (shell syntax check)"
  fi

  if [ -n "${_gate_failed:-}" ]; then
    _gate_label="bash-n"
    log "SHELL SYNTAX CHECK FAILED. Branch NOT merged."
    tg "❌ *$SKYNET_PROJECT_NAME_UPPER W${WORKER_ID} FAILED*: $task_title (shell syntax error)"
    emit_event "task_failed" "Worker $WORKER_ID: $task_title (gate: bash-n)"
    tasks_failed=$((tasks_failed + 1))
    cleanup_worktree
    [ -n "${_db_task_id:-}" ] && { db_fail_task "$_db_task_id" "$branch_name" "bash-n failed" "shell_syntax" || log "WARNING: db_fail_task failed — task may not be recorded as failed"; }
    db_set_worker_idle "$WORKER_ID" "Last failure: $task_title (bash-n failed)" 2>/dev/null || log "WARNING: db_set_worker_idle failed — dashboard may show stale worker status"
    emit_event "worker_idle" "Worker $WORKER_ID: bash-n failed — $task_title"
    _CURRENT_TASK_TITLE=""
    _CURRENT_TASK_ID=""
    _one_shot_exit=1
    continue
  fi

  # --- Non-blocking: Check server logs for runtime errors ---
  if [ -f "$SERVER_LOG" ]; then
    log "Checking server logs for runtime errors..."
    bash "$SCRIPTS_DIR/check-server-errors.sh" "$LOG_DIR/next-dev-w${WORKER_ID}.log" >> "$LOG" 2>&1 || \
      log "Server errors found -- written to blockers.md (non-blocking for merge)"
  fi

  # --- Graceful shutdown checkpoint (before merge) ---
  if $SHUTDOWN_REQUESTED; then
    log "Shutdown requested before merge — unclaiming task and exiting cleanly"
    [ -n "${_db_task_id:-}" ] && { db_unclaim_task "$_db_task_id" || { sleep 1; db_unclaim_task "$_db_task_id" 2>/dev/null || log "ERROR: db_unclaim_task failed twice for task $_db_task_id — watchdog will recover"; }; }

    _CURRENT_TASK_TITLE=""
    _CURRENT_TASK_ID=""
    cleanup_worktree "$branch_name"
    break
  fi

  # --- Pre-lock rebase: reduce merge lock hold time ---
  # Rebase feature branch onto latest main while still in worktree.
  # If successful, the subsequent merge will be a fast-forward (instant).
  _pre_lock_rebased=false
  if [ -d "$WORKTREE_DIR" ]; then
    log "Pre-lock rebase: updating $branch_name onto latest $SKYNET_MAIN_BRANCH..."
    if (cd "$WORKTREE_DIR" && git fetch origin "$SKYNET_MAIN_BRANCH" 2>>"$LOG" && \
        git rebase "origin/$SKYNET_MAIN_BRANCH" 2>>"$LOG"); then
      _pre_lock_rebased=true
      log "Pre-lock rebase succeeded — merge should be fast-forward."
    else
      (cd "$WORKTREE_DIR" && git rebase --abort 2>/dev/null || true)
      log "Pre-lock rebase had conflicts — will use regular merge."
    fi
  fi

  # --- All gates passed -- merge to main ---
  log "All checks passed. Merging $branch_name into $SKYNET_MAIN_BRANCH."

  # Collect files touched before merge (worktree may be removed after merge)
  _files_touched=""
  if [ -d "$WORKTREE_DIR" ]; then
    _files_touched=$(cd "$WORKTREE_DIR" && git diff --name-only "origin/$SKYNET_MAIN_BRANCH"...HEAD 2>/dev/null || true)
  fi

  # Define state commit hook for do_merge_to_main
  task_duration_secs=$(( $(date +%s) - task_start_epoch ))
  task_duration=$(format_duration $task_duration_secs)

  _worker_state_commit() {
    # SQLite: mark task completed
    if [ -n "${_db_task_id:-}" ]; then
      db_complete_task "$_db_task_id" "merged to $SKYNET_MAIN_BRANCH" "$task_duration" "$task_duration_secs" "success" || log "WARNING: db_complete_task failed — task may not be recorded as completed"
      # Record files touched by this task
      if [ -n "$_files_touched" ]; then
        db_set_files_touched "$_db_task_id" "$_files_touched" || log "WARNING: db_set_files_touched failed"
      fi
    fi
    if [ "${SKYNET_ONE_SHOT:-}" != "true" ]; then
      # Regenerate state files from SQLite (authoritative source)
      db_export_state_files
    fi

    cat > "$WORKER_TASK_FILE" <<WEOF
# Current Task
## $task_title
**Status:** completed
**Started:** $(date '+%Y-%m-%d %H:%M')
**Completed:** $(date '+%Y-%m-%d')
**Branch:** $branch_name
**Worker:** $WORKER_ID

### Changes
-- See git log for details
WEOF

    # Commit pipeline status updates (skip in one-shot mode — task was never in backlog)
    if [ "${SKYNET_ONE_SHOT:-}" != "true" ]; then
      git add "$BACKLOG" "$WORKER_TASK_FILE" "$COMPLETED" "$FAILED" "$BLOCKERS" 2>/dev/null || true
      if git commit -m "chore: update pipeline status after $task_title" --no-verify 2>>"$LOG"; then
        return 0
      else
        log "WARNING: State file commit failed — code merge will push without state update"
        return 1
      fi
    fi
    return 1  # no state commit in one-shot mode
  }
  _MERGE_STATE_COMMIT_FN="_worker_state_commit"

  # Call shared merge function (guard against SIGTERM during merge)
  _IN_MERGE=true
  _merge_rc=0
  do_merge_to_main "$branch_name" "$WORKTREE_DIR" "$LOG" "$_pre_lock_rebased" || _merge_rc=$?
  _IN_MERGE=false
  log "TRACE=$TRACE_ID Merge result: rc=$_merge_rc"

  # If shutdown was requested during merge, exit now that merge is complete
  if $SHUTDOWN_REQUESTED; then
    log "Deferred shutdown completing now (merge finished with rc=$_merge_rc)"
    break
  fi

  # Clear task title AFTER merge — ensures cleanup_on_exit can
  # properly unclaim if worker crashes between merge and state commit
  case $_merge_rc in
    0)
      # Success — merged + pushed
      _CURRENT_TASK_TITLE=""
      _CURRENT_TASK_ID=""
      ;;
    1)
      # Merge conflict
      log "MERGE FAILED for $branch_name — moving to failed."
      emit_event "merge_conflict" "Worker $WORKER_ID: $task_title on $branch_name"
      tasks_failed=$((tasks_failed + 1))
      [ -n "${_db_task_id:-}" ] && { db_fail_task "$_db_task_id" "$branch_name" "merge conflict" "merge_conflict" || log "WARNING: db_fail_task failed — task may not be recorded as failed"; }
      db_export_state_files
      _CURRENT_TASK_TITLE=""
      _CURRENT_TASK_ID=""
      _one_shot_exit=1
      tg "❌ *$SKYNET_PROJECT_NAME_UPPER W${WORKER_ID}*: merge failed for $task_title"
      continue
      ;;
    2)
      # Typecheck failed post-merge (already reverted + pushed)
      emit_event "task_reverted" "Worker $WORKER_ID: $task_title (typecheck failed post-merge)" || true
      tg "🔄 *${SKYNET_PROJECT_NAME_UPPER} W${WORKER_ID} REVERTED*: $task_title (typecheck failed post-merge)" || true
      tasks_failed=$((tasks_failed + 1))
      [ -n "${_db_task_id:-}" ] && { db_fail_task "$_db_task_id" "$branch_name" "typecheck failed post-merge" "typecheck_post_merge" || log "WARNING: db_fail_task failed — task may not be recorded as failed"; }
      db_export_state_files || true
      db_set_worker_idle "$WORKER_ID" "Last: $task_title (typecheck failed post-merge)" 2>/dev/null || log "WARNING: db_set_worker_idle failed — dashboard may show stale worker status"
      emit_event "worker_idle" "Worker $WORKER_ID: typecheck failed post-merge — $task_title" || true
      _CURRENT_TASK_TITLE=""
      _CURRENT_TASK_ID=""
      _one_shot_exit=1
      continue
      ;;
    3)
      # Critical failure (revert failed, main may be broken)
      tg "🚨 *${SKYNET_PROJECT_NAME_UPPER}* CRITICAL: revert failed for $task_title — main may be broken" || true
      emit_event "revert_failed" "Worker $WORKER_ID: $task_title — critical merge failure" || true
      [ -n "${_db_task_id:-}" ] && { db_fail_task "$_db_task_id" "$branch_name" "critical merge failure" "critical_merge" || log "WARNING: db_fail_task failed — task may not be recorded as failed"; }
      _CURRENT_TASK_TITLE=""
      _CURRENT_TASK_ID=""
      exit 1
      ;;
    4)
      # Merge lock contention
      emit_event "merge_lock_contention" "Worker $WORKER_ID: $task_title"
      [ -n "${_db_task_id:-}" ] && { db_unclaim_task "$_db_task_id" || { sleep 1; db_unclaim_task "$_db_task_id" 2>/dev/null || log "ERROR: db_unclaim_task failed twice for task $_db_task_id — watchdog will recover"; }; }
      db_export_state_files 2>/dev/null || true
      _CURRENT_TASK_TITLE=""
      _CURRENT_TASK_ID=""
      cleanup_worktree "$branch_name"
      continue
      ;;
    5)
      # Pull failed
      [ -n "${_db_task_id:-}" ] && { db_unclaim_task "$_db_task_id" || { sleep 1; db_unclaim_task "$_db_task_id" 2>/dev/null || log "ERROR: db_unclaim_task failed twice for task $_db_task_id — watchdog will recover"; }; }
      _CURRENT_TASK_TITLE=""
      _CURRENT_TASK_ID=""
      continue
      ;;
    6)
      # Push failed (reverted + pushed revert)
      tg "🔄 *${SKYNET_PROJECT_NAME_UPPER} W${WORKER_ID} REVERTED*: $task_title (push failed)"
      emit_event "task_reverted" "Worker $WORKER_ID: $task_title (push failed post-merge)"
      tasks_failed=$((tasks_failed + 1))
      [ -n "${_db_task_id:-}" ] && { db_fail_task "$_db_task_id" "$branch_name" "push failed post-merge" "push_failed" || log "WARNING: db_fail_task failed — task may not be recorded as failed"; }
      db_export_state_files
      _CURRENT_TASK_TITLE=""
      _CURRENT_TASK_ID=""
      continue
      ;;
    7)
      # Smoke test failed (reverted + pushed)
      [ -n "${_db_task_id:-}" ] && { db_fail_task "$_db_task_id" "$branch_name" "smoke test failed" "smoke_test" || log "WARNING: db_fail_task failed — task may not be recorded as failed"; }
      db_export_state_files
      _CURRENT_TASK_TITLE=""
      _CURRENT_TASK_ID=""
      _one_shot_exit=1
      tg "🔄 *$SKYNET_PROJECT_NAME_UPPER W${WORKER_ID} REVERTED*: $task_title (smoke test failed)"
      emit_event "task_reverted" "Worker $WORKER_ID: $task_title (smoke test failed)"
      log "Merge reverted. Task moved to failed-tasks."
      continue
      ;;
  esac

  # OPS-P1-3: Clear claim tracker for this task on successful completion.
  # P0-FIX: Wrap in the same mkdir lock used for claim tracker reads (lines 337-384)
  # to prevent concurrent workers from overwriting each other's pruning.
  if [ -n "${_db_task_id:-}" ] && [ -f "/tmp/skynet-${SKYNET_PROJECT_NAME}-claim-attempts" ]; then
    _ct_cleanup_lock="/tmp/skynet-${SKYNET_PROJECT_NAME}-claim-attempts.lock"
    _ct_cleanup_locked=false
    _ct_cleanup_i=0
    while [ "$_ct_cleanup_i" -lt 5 ]; do
      if mkdir "$_ct_cleanup_lock" 2>/dev/null; then
        _ct_cleanup_locked=true
        break
      fi
      _ct_cleanup_i=$((_ct_cleanup_i + 1))
      perl -e 'select(undef,undef,undef,0.1)' 2>/dev/null || sleep 1
    done
    if $_ct_cleanup_locked; then
      grep -v "|${_db_task_id}$" "/tmp/skynet-${SKYNET_PROJECT_NAME}-claim-attempts" > "/tmp/skynet-${SKYNET_PROJECT_NAME}-claim-attempts.tmp" 2>/dev/null || true
      mv "/tmp/skynet-${SKYNET_PROJECT_NAME}-claim-attempts.tmp" "/tmp/skynet-${SKYNET_PROJECT_NAME}-claim-attempts" 2>/dev/null || true
      rmdir "$_ct_cleanup_lock" 2>/dev/null || rm -rf "$_ct_cleanup_lock" 2>/dev/null || true
    else
      log "WARNING: Claim tracker lock contention during cleanup — skipping prune for task $_db_task_id"
    fi
  fi

  log "TRACE=$TRACE_ID Task completed"
  log "Task completed and merged to $SKYNET_MAIN_BRANCH: $task_title"
  remaining=$(db_count_pending 2>/dev/null || grep -c '^\- \[ \]' "$BACKLOG" 2>/dev/null || echo 0)
  remaining=${remaining:-0}
  tg "✅ *$SKYNET_PROJECT_NAME_UPPER W${WORKER_ID} MERGED*: $task_title ($remaining tasks remaining)"
  emit_event "task_completed" "Worker $WORKER_ID: $task_title"
  tasks_completed=$((tasks_completed + 1))

  # Reset worker to idle between tasks so dashboard shows accurate status
  db_clear_intent "$WORKER_ID" 2>/dev/null || true
  db_set_worker_status "$WORKER_ID" "dev" "idle" "" "" "" 2>/dev/null || log "WARNING: db_set_worker_status failed — dashboard may show stale worker status"
  # Reset progress epoch so next task starts fresh (prevents false hung-worker detection)
  db_update_progress "$WORKER_ID" 2>/dev/null || true
done

# Worker loop finished — ensure status is idle before exit
db_clear_intent "$WORKER_ID" 2>/dev/null || true
db_set_worker_status "$WORKER_ID" "dev" "idle" "" "" "" 2>/dev/null || log "WARNING: db_set_worker_status failed — dashboard may show stale worker status"

log "Dev worker $WORKER_ID finished: $tasks_attempted attempted, $tasks_completed completed, $tasks_failed failed."
emit_event "worker_session_end" "Worker $WORKER_ID: $tasks_completed completed, $tasks_failed failed of $tasks_attempted attempted"

# In one-shot mode, propagate task failure as non-zero exit
if [ "${SKYNET_ONE_SHOT:-}" = "true" ] && [ "$_one_shot_exit" -ne 0 ]; then
  exit "$_one_shot_exit"
fi
