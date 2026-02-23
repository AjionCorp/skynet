#!/usr/bin/env bash
# watchdog.sh — Persistent dispatcher that keeps the pipeline alive
# Loops every 3 min. Checks if workers are idle with work waiting, kicks them off.
# Does NOT invoke Claude itself — just launches the worker scripts.
# Auth-aware: skips Claude-dependent workers when auth is expired.
# Crash recovery: detects stale locks, unclaims orphaned tasks, kills orphan processes.
set -uo pipefail  # no -e: loop must survive individual cycle failures

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_config.sh"

# _config.sh re-enables set -e; disable it again so the loop survives failures
set +e

LOG="$SCRIPTS_DIR/watchdog.log"
WATCHDOG_LOCK_DIR="${SKYNET_LOCK_PREFIX}-watchdog.lock"
WATCHDOG_INTERVAL="${SKYNET_WATCHDOG_INTERVAL:-180}"  # seconds between cycles (default 3 min)
WORKTREE_BASE="${SKYNET_WORKTREE_BASE:-${DEV_DIR}/worktrees}"

cd "$PROJECT_DIR"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }

# --- Singleton enforcement via mkdir-based atomic lock ---
if mkdir "$WATCHDOG_LOCK_DIR" 2>/dev/null; then
  echo $$ > "$WATCHDOG_LOCK_DIR/pid"
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
      echo $$ > "$WATCHDOG_LOCK_DIR/pid"
    else
      log "Watchdog lock contention. Exiting."
      exit 0
    fi
  else
    log "Watchdog lock contention. Exiting."
    exit 0
  fi
fi

_watchdog_cleanup() {
  rm -rf "$WATCHDOG_LOCK_DIR"
}
trap _watchdog_cleanup EXIT INT TERM

log "Watchdog started (PID $$, interval ${WATCHDOG_INTERVAL}s)"

# --- Main loop ---
while true; do
(
set -euo pipefail
trap 'log "Watchdog cycle failed at line $LINENO"' ERR

# Rotate watchdog's own log if it exceeds configurable threshold
rotate_log_if_needed "$LOG"

# Trim logs to last 24h on each watchdog run
bash "$SCRIPTS_DIR/clean-logs.sh" 2>/dev/null || true

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

# --- Backlog mutex helpers (same pattern as dev-worker.sh) ---


# --- Crash recovery: detect stale locks, orphaned tasks, and zombie processes ---
crash_recovery() {
  local recovered=0
  local _cr_stale_pids=0 _cr_orphaned_tasks=0 _cr_cleaned_worktrees=0

  # Phase 1: Check all known lock files for stale/zombie PIDs
  local all_locks=()
  for _wid in $(seq 1 "${SKYNET_MAX_WORKERS:-4}"); do
    all_locks+=("${SKYNET_LOCK_PREFIX}-dev-worker-${_wid}.lock")
  done
  all_locks+=("${SKYNET_LOCK_PREFIX}-task-fixer.lock")
  for _fid in $(seq 2 "${SKYNET_MAX_FIXERS:-3}"); do
    all_locks+=("${SKYNET_LOCK_PREFIX}-task-fixer-${_fid}.lock")
  done
  all_locks+=("${SKYNET_LOCK_PREFIX}-project-driver.lock")

  for lockfile in "${all_locks[@]}"; do
    # Handle orphaned lock dirs (mkdir succeeded but process died before writing pid file)
    if [ -d "$lockfile" ] && [ ! -f "$lockfile/pid" ]; then
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
    elif [ -f "$lockfile" ]; then
      lock_pid=$(cat "$lockfile" 2>/dev/null || echo "")
    else
      continue
    fi
    [ -z "$lock_pid" ] && { rm -rf "$lockfile"; recovered=$((recovered + 1)); continue; }

    local stale=false

    if ! kill -0 "$lock_pid" 2>/dev/null; then
      # PID is dead — lock is stale (crash bypassed EXIT trap)
      stale=true
      log "Stale lock: $lockfile (PID $lock_pid dead)"
    else
      # PID alive — check if it's been running too long (zombie/hung worker)
      local lock_mtime
      lock_mtime=$(file_mtime "$lockfile")
      local now=$(date +%s)
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
    fi
  done

  # Phase 2: Recover partial task states — unclaim [>] tasks from dead workers
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
        db_unclaim_task_by_title "$stuck_title" 2>/dev/null || true
        log "Unclaimed stuck task from worker $wid: $stuck_title"
        recovered=$((recovered + 1))
        _cr_orphaned_tasks=$((_cr_orphaned_tasks + 1))
      fi
      # Reset current-task file and SQLite worker status to idle
      db_set_worker_idle "$wid" "dead worker recovered by watchdog" 2>/dev/null || true
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
          db_unclaim_task_by_title "$title" 2>/dev/null || true
          log "Unclaimed orphaned task (no workers alive): $title"
          recovered=$((recovered + 1))
          _cr_orphaned_tasks=$((_cr_orphaned_tasks + 1))
        done <<< "$claimed_lines"
      fi
    fi
  fi

  # Phase 3: Kill orphan processes in worktree directories and clean up worktrees
  local worktree_dirs=()
  for _wid in $(seq 1 "${SKYNET_MAX_WORKERS:-4}"); do
  worktree_dirs+=("${WORKTREE_BASE}/w${_wid}:${SKYNET_LOCK_PREFIX}-dev-worker-${_wid}.lock")
  done
worktree_dirs+=("${WORKTREE_BASE}/fixer-1:${SKYNET_LOCK_PREFIX}-task-fixer.lock")
  for _fid in $(seq 2 "${SKYNET_MAX_FIXERS:-3}"); do
  worktree_dirs+=("${WORKTREE_BASE}/fixer-${_fid}:${SKYNET_LOCK_PREFIX}-task-fixer-${_fid}.lock")
  done

  for entry in "${worktree_dirs[@]}"; do
    local wt_dir="${entry%%:*}"
    local wt_lock="${entry##*:}"

    # If worktree exists but its worker is NOT running — it's orphaned
    [ -d "$wt_dir" ] || continue
    is_running "$wt_lock" && continue

    # Kill any orphan processes running inside the worktree (claude, node, etc.)
    # NOTE: pgrep -f matches against the full command line. Using the resolved absolute
    # path reduces (but doesn't eliminate) false positives from unrelated processes whose
    # command lines happen to contain a similar substring.
    local resolved_wt_dir
    resolved_wt_dir=$(cd "$wt_dir" 2>/dev/null && pwd -P || echo "$wt_dir")
    local orphan_pids
    orphan_pids=$(pgrep -f "$resolved_wt_dir" 2>/dev/null | grep -v "^$$\$" || true)
    if [ -n "$orphan_pids" ]; then
      log "Killing orphan processes in $wt_dir: $(echo "$orphan_pids" | tr '\n' ' ')"
      echo "$orphan_pids" | xargs kill -TERM 2>/dev/null || true
      sleep 1
      echo "$orphan_pids" | xargs kill -9 2>/dev/null || true
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
  done

  if [ "$recovered" -gt 0 ]; then
    log "Crash recovery: $recovered item(s) — ${_cr_stale_pids} stale PIDs, ${_cr_orphaned_tasks} orphaned tasks, ${_cr_cleaned_worktrees} worktrees cleaned"
    tg "🔄 *$SKYNET_PROJECT_NAME_UPPER WATCHDOG*: Crash recovery — ${_cr_stale_pids} stale PIDs, ${_cr_orphaned_tasks} orphaned tasks, ${_cr_cleaned_worktrees} worktrees"
  fi
}

# --- Run crash recovery before dispatching ---
crash_recovery

# --- Reconcile orphaned 'claimed' tasks ---
# NOTE: Reconciliation counters are logged per-event (log + emit_event) rather
# than aggregated, ensuring accuracy regardless of which code path runs.
# If a task is 'claimed' in SQLite but the worker that claimed it is either dead
# or working on a different task, unclaim it back to 'pending'.
# Time guard: only reconcile claims older than ORPHAN_CUTOFF to avoid racing with
# the ~50-200ms gap between db_claim_next_task and db_set_worker_status in dev-worker.
_ORPHAN_CUTOFF="${SKYNET_ORPHAN_CUTOFF_SECONDS:-120}"
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
    db_unclaim_task "$_oc_id" 2>/dev/null || true
    log "Reconciled orphaned claim: task '$_oc_title' (id=$_oc_id, worker=$_oc_wid)"
    emit_event "orphaned_claim_reconciled" "Task '$_oc_title' (id=$_oc_id) unclaimed — worker $_oc_wid not actively working on it" 2>/dev/null || true
  done <<< "$_orphaned_claimed"
fi

# --- Reconcile stale 'fixing-N' tasks ---
# If a fixer crashes, the task stays in 'fixing-N' status forever because
# db_get_pending_failures() only queries status='failed'. Detect stale fixing
# tasks where the fixer is dead and reset them to 'failed' for retry.
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
    " 2>/dev/null || true
    log "Reconciled stale fixing task: '$_sf_title' (id=$_sf_id, fixer=$_sf_fid) — reset to failed"
    emit_event "stale_fixing_reconciled" "Task '$_sf_title' (id=$_sf_id) reset to failed — fixer $_sf_fid is dead" 2>/dev/null || true
  done <<< "$_stale_fixing"
fi

# --- Proactive merge lock cleanup ---
# If the merge lock holder's PID is dead (or PID file is missing, indicating a
# crash between mkdir and PID write), remove the lock immediately rather than
# waiting for the 120s stale timeout to expire.
if [ -d "$MERGE_LOCK" ]; then
  _ml_pid=""
  [ -f "$MERGE_LOCK/pid" ] && _ml_pid=$(cat "$MERGE_LOCK/pid" 2>/dev/null || echo "")
  if [ -z "$_ml_pid" ]; then
    # No PID file — process crashed between mkdir and PID write; reclaim
    log "Merge lock has no PID file — removing stale lock proactively"
    rm -rf "$MERGE_LOCK" 2>/dev/null || true
  elif ! kill -0 "$_ml_pid" 2>/dev/null; then
    log "Merge lock held by dead PID $_ml_pid — removing proactively"
    rm -rf "$MERGE_LOCK" 2>/dev/null || true
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
    _restore_backup=$(ls -1t "$DEV_DIR/db-backups"/skynet.db.2* 2>/dev/null | head -1)
    if [ -n "$_restore_backup" ]; then
      log "Attempting automatic DB restore from $_restore_backup"
      _backup_check=$(sqlite3 "$_restore_backup" "PRAGMA quick_check;" 2>/dev/null | head -1)
      if [ "$_backup_check" = "ok" ]; then
        cp "$DB_PATH" "$DB_PATH.corrupted.$(date +%s)"
        sqlite3 "$_restore_backup" ".backup '$DB_PATH'"
        _restore_check=$(sqlite3 "$DB_PATH" "PRAGMA quick_check;" 2>/dev/null | head -1)
        if [ "$_restore_check" = "ok" ]; then
          _db_healthy=true
          log "DB restore succeeded from $_restore_backup"
          tg "✅ *$SKYNET_PROJECT_NAME_UPPER WATCHDOG*: SQLite auto-restored from backup $_restore_backup"
        else
          log "CRITICAL: DB restore verification failed"
          tg "🚨 *$SKYNET_PROJECT_NAME_UPPER WATCHDOG*: DB restore failed verification. Manual intervention required."
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
_backup_sentinel="/tmp/skynet-${SKYNET_PROJECT_NAME}-db-backup-$(date +%Y%m%d)"
if [ -f "$DB_PATH" ] && $_db_healthy && [ ! -f "$_backup_sentinel" ]; then
  mkdir -p "$DEV_DIR/db-backups"
  _backup_file="$DEV_DIR/db-backups/skynet.db.$(date +%Y%m%d)"
  if sqlite3 "$DB_PATH" ".backup '$_backup_file'" 2>/dev/null; then
    touch "$_backup_sentinel"
    log "Daily DB backup created: $_backup_file"
    # Rotate: keep 7 days
    ls -1t "$DEV_DIR/db-backups"/skynet.db.* 2>/dev/null | tail -n +8 | while read -r _old; do
      rm -f "$_old"
    done
  else
    log "WARNING: Daily DB backup failed"
  fi
fi

# Clean up old /tmp sentinel files (older than 7 days) to prevent accumulation
find /tmp -maxdepth 1 -name "skynet-${SKYNET_PROJECT_NAME}-*" -mtime +7 -type f -delete 2>/dev/null || true

# --- Validate backlog health (duplicates, orphaned claims, bad refs) ---
validate_backlog

# --- Auth pre-check: don't kick off Claude workers if auth is down ---
# Uses shared check_claude_auth which auto-triggers auth-refresh on failure
source "$SCRIPTS_DIR/auth-check.sh"
agent_auth_ok=false
claude_auth_ok=false
if check_claude_auth; then
  claude_auth_ok=true
  agent_auth_ok=true
fi

# Also check Codex auth (non-blocking — just sets fail flag for awareness)
codex_auth_ok=false
if check_codex_auth; then
  codex_auth_ok=true
  agent_auth_ok=true
fi

# --- Token expiry pre-warning ---
# Check Claude token and Codex token expiry. Alert once if within 24h.
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
        touch "$_expiry_sentinel"
      fi
      ;;
    ok:*)
      rm -f "$_expiry_sentinel" 2>/dev/null || true
      ;;
  esac
fi

# Count backlog tasks (prefer SQLite, fallback to grep)
backlog_count=$(db_count_pending 2>/dev/null || grep -c '^\- \[ \]' "$BACKLOG" 2>/dev/null || echo 0)
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
is_running "${SKYNET_LOCK_PREFIX}-project-driver.lock" && driver_running=true

# --- Stale heartbeat detection ---
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

  if [ "$hb_age" -gt "$stale_seconds" ]; then
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
      db_unclaim_task_by_title "$task_title" 2>/dev/null || true
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
    db_set_worker_idle "$wid" "stale worker killed after ${age_min}m" 2>/dev/null || true
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

# --- Normalize a task title for fuzzy matching ---
# Strips tags ([FIX], [FEAT], etc.), strips "FRESH implementation" suffix,
# lowercases, collapses whitespace, and truncates to first 50 characters.
_normalize_title() {
  echo "$1" | \
    sed 's/\[[A-Z][A-Z]*\] *//g' | \
    sed 's/ *[-—]* *FRESH implementation.*$//' | \
    tr '[:upper:]' '[:lower:]' | \
    sed 's/  */ /g; s/^ *//; s/ *$//' | \
    cut -c1-50
}

# --- Run auto-supersede before branch cleanup (so newly-superseded entries get cleaned) ---
# SQLite auto-supersede (atomic, handles normalized root matching)
_db_superseded=$(db_auto_supersede_completed 2>/dev/null || echo 0)
if [ "${_db_superseded:-0}" -gt 0 ] 2>/dev/null; then
  log "SQLite auto-superseded $_db_superseded failed task(s)"
fi

# --- Archive old completed tasks to prevent unbounded state file growth ---
# If completed.md has >100 entries, move entries older than 7 days to
# completed-archive.md, keeping only the most recent 100 in the active file.
# NOTE: Operates on generated completed.md rather than SQLite directly.
# This is acceptable since completed.md is regenerated at merge time.
_archive_old_completions() {
  [ -f "$COMPLETED" ] || return 0

  local header_lines=2
  local max_entries=100
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
    # Not enough old entries to archive while keeping 100 — skip
    return 0
  fi

  # Create or append to archive file (with header if new)
  if [ ! -f "$archive" ]; then
    head -n "$header_lines" "$COMPLETED" > "$archive"
  fi
  printf '%s' "$archive_lines" >> "$archive"

  # Rewrite completed.md with header + kept entries
  head -n "$header_lines" "$COMPLETED" > "$COMPLETED.tmp"
  printf '%s' "$keep_lines" >> "$COMPLETED.tmp"
  mv "$COMPLETED.tmp" "$COMPLETED"

  log "Archived $archived_count completed entries older than $max_age_days days"
}

# --- Run archival before branch cleanup ---
_archive_old_completions

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

# --- Health score alert ---
# Mirrors the pipeline-status handler logic:
#   Start at 100, -5 per pending failed task, -10 per active blocker, -2 per stale heartbeat.
# Alerts once when score drops below threshold; clears sentinel when score recovers.
_health_score_alert() {
  local threshold="${SKYNET_HEALTH_ALERT_THRESHOLD:-50}"
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
      date +%s > "$sentinel"
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
      date +%s > "$_smoke_fail_sentinel"
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

# --- Pipeline pause check (skip dispatch but still run health checks above) ---
pipeline_paused=false
if [ -f "$DEV_DIR/pipeline-paused" ]; then
  pipeline_paused=true
  log "Pipeline is paused. Skipping worker dispatch."
fi

# --- Only kick Claude-dependent workers if auth is OK and DB is healthy ---
if ! $_db_healthy; then
  log "Skipping dispatch — DB unhealthy"
elif $agent_auth_ok && ! $pipeline_paused; then
  # Rule 1: Kick dev-workers proportional to backlog size
  # Worker N starts when backlog has >= N tasks and worker N is idle
  for _wid in $(seq 1 "${SKYNET_MAX_WORKERS:-4}"); do
    if [ "$backlog_count" -ge "$_wid" ] && ! is_running "${SKYNET_LOCK_PREFIX}-dev-worker-${_wid}.lock"; then
      log "Backlog has $backlog_count tasks (>=$_wid), worker $_wid idle. Kicking off."
      tg "👁 *WATCHDOG*: Kicking off dev-worker $_wid ($backlog_count tasks waiting)"
      SKYNET_DEV_DIR="$DEV_DIR" nohup bash "$SCRIPTS_DIR/dev-worker.sh" "$_wid" >> "$SCRIPTS_DIR/dev-worker-${_wid}.log" 2>&1 &
    fi
  done

  # Rule 2: Kick task-fixers proportional to failed task count
  # Check fixer cooldown first — skip all fixers if cooling down
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
          SKYNET_DEV_DIR="$DEV_DIR" nohup bash "$SCRIPTS_DIR/task-fixer.sh" "$_fid" >> "$_fixer_log" 2>&1 &
        fi
      fi
    done
  fi

  # Rule 3: Kick off project-driver if needed (rate-limited)
  if ! $driver_running; then
    should_kick=false
    last_kick_file="${SKYNET_LOCK_PREFIX}-project-driver-last-kick"
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
      tg "📋 *$SKYNET_PROJECT_NAME_UPPER*: Kicking off project-driver (backlog: $backlog_count tasks)"
      SKYNET_DEV_DIR="$DEV_DIR" nohup bash "$SCRIPTS_DIR/project-driver.sh" >> "$SCRIPTS_DIR/project-driver.log" 2>&1 &
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

# --- Adaptive interval: shorter when work is available, longer when idle ---
# NOTE: _adaptive_file path must match between this inner scope (subshell) and the
# outer scope below that reads it. Both use "/tmp/skynet-${SKYNET_PROJECT_NAME}-watchdog-interval"
# via variable interpolation from the same SKYNET_PROJECT_NAME env var.
_adaptive_file="/tmp/skynet-${SKYNET_PROJECT_NAME}-watchdog-interval"
if [ "${backlog_count:-0}" -gt 0 ] || [ "${failed_pending:-0}" -gt 0 ]; then
  echo 30 > "$_adaptive_file"
elif [ "${dev_workers_running:-0}" -gt 0 ] || [ "${fixers_running:-0}" -gt 0 ]; then
  echo "$WATCHDOG_INTERVAL" > "$_adaptive_file"
else
  echo 300 > "$_adaptive_file"
fi

) || { log "Watchdog cycle failed (exit $?) — will retry next cycle"; true; }

# Read adaptive interval from subshell output (falls back to default)
_adaptive_file="/tmp/skynet-${SKYNET_PROJECT_NAME}-watchdog-interval"
_cycle_interval="$WATCHDOG_INTERVAL"
[ -f "$_adaptive_file" ] && _cycle_interval=$(cat "$_adaptive_file" 2>/dev/null || echo "$WATCHDOG_INTERVAL")
sleep "$_cycle_interval"

done  # end main loop
