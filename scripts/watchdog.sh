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
    rm -rf "$WATCHDOG_LOCK_DIR" 2>/dev/null || true
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
BACKLOG_LOCK="${SKYNET_LOCK_PREFIX}-backlog.lock"

acquire_lock() {
  local attempts=0
  while ! mkdir "$BACKLOG_LOCK" 2>/dev/null; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 50 ]; then
      if [ -d "$BACKLOG_LOCK" ]; then
        local lock_mtime
        lock_mtime=$(file_mtime "$BACKLOG_LOCK")
        local lock_age=$(( $(date +%s) - lock_mtime ))
        if [ "$lock_age" -gt 30 ]; then
          rm -rf "$BACKLOG_LOCK" 2>/dev/null || true
          mkdir "$BACKLOG_LOCK" 2>/dev/null && return 0
        fi
      fi
      return 1
    fi
    sleep 0.1
  done
  return 0
}

release_lock() {
  rmdir "$BACKLOG_LOCK" 2>/dev/null || rm -rf "$BACKLOG_LOCK" 2>/dev/null || true
}

unclaim_task() {
  local task_title="$1"
  acquire_lock || return
  if [ -f "$BACKLOG" ]; then
    __AWK_TITLE="$task_title" awk 'BEGIN{title=ENVIRON["__AWK_TITLE"]} {
      if ($0 == "- [>] " title) print "- [ ] " title
      else print
    }' "$BACKLOG" > "$BACKLOG.tmp"
    mv "$BACKLOG.tmp" "$BACKLOG"
  fi
  release_lock
}

# --- Crash recovery: detect stale locks, orphaned tasks, and zombie processes ---
crash_recovery() {
  local recovered=0

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
        # Graceful kill first, then force
        kill -TERM "$lock_pid" 2>/dev/null || true
        sleep 2
        kill -0 "$lock_pid" 2>/dev/null && kill -9 "$lock_pid" 2>/dev/null || true
      fi
    fi

    if $stale; then
      rm -rf "$lockfile"
      recovered=$((recovered + 1))
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
        unclaim_task "$stuck_title"
        log "Unclaimed stuck task from worker $wid: $stuck_title"
        recovered=$((recovered + 1))
      fi
      # Reset current-task file to idle so the worker doesn't see stale in_progress
      cat > "$task_file" <<IDLE_EOF
# Current Task
**Status:** idle
**Last failure:** $(date '+%Y-%m-%d %H:%M') -- ${stuck_title:-unknown} (dead worker recovered by watchdog)
IDLE_EOF
    fi
  done

  # Also check for any [>] entries in backlog with no live worker at all
  if [ -f "$BACKLOG" ]; then
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
          unclaim_task "$title"
          log "Unclaimed orphaned task (no workers alive): $title"
          recovered=$((recovered + 1))
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
    local orphan_pids
    orphan_pids=$(pgrep -f "$wt_dir" 2>/dev/null || true)
    if [ -n "$orphan_pids" ]; then
      log "Killing orphan processes in $wt_dir: $(echo $orphan_pids | tr '\n' ' ')"
      echo "$orphan_pids" | xargs kill -TERM 2>/dev/null || true
      sleep 1
      echo "$orphan_pids" | xargs kill -9 2>/dev/null || true
    fi

    # Remove the orphan worktree
    cd "$PROJECT_DIR"
    git worktree remove "$wt_dir" --force 2>/dev/null || rm -rf "$wt_dir" 2>/dev/null || true
    git worktree prune 2>/dev/null || true
    log "Cleaned orphan worktree: $wt_dir"
    recovered=$((recovered + 1))
  done

  if [ "$recovered" -gt 0 ]; then
    log "Crash recovery complete: recovered $recovered item(s)"
    tg "🔄 *$SKYNET_PROJECT_NAME_UPPER WATCHDOG*: Crash recovery — cleaned $recovered stale lock(s)/orphaned task(s)"
  fi
}

# --- Run crash recovery before dispatching ---
crash_recovery

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

# Count backlog tasks (grep -c exits 1 on no match, so use || true and default)
backlog_count=$(grep -c '^\- \[ \]' "$BACKLOG" 2>/dev/null || true)
backlog_count=${backlog_count:-0}
backlog_count=$((backlog_count + 0))

# Count pending failed tasks
failed_pending=$(grep -c '| pending |' "$FAILED" 2>/dev/null || true)
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
      # Acquire backlog lock for safe modification
      local backlog_lock="${SKYNET_LOCK_PREFIX}-backlog.lock"
      if mkdir "$backlog_lock" 2>/dev/null; then
        if [ -f "$BACKLOG" ]; then
          __AWK_TITLE="$task_title" awk 'BEGIN{title=ENVIRON["__AWK_TITLE"]} {
            if ($0 == "- [>] " title) print "- [ ] " title
            else print
          }' "$BACKLOG" > "$BACKLOG.tmp"
          mv "$BACKLOG.tmp" "$BACKLOG"
        fi
        rmdir "$backlog_lock" 2>/dev/null || rm -rf "$backlog_lock" 2>/dev/null || true
      fi
      log "Unclaimed task: $task_title"
    fi

    # Remove the worktree
    cd "$PROJECT_DIR"
    if [ -d "$worktree" ]; then
      git worktree remove "$worktree" --force 2>/dev/null || rm -rf "$worktree" 2>/dev/null || true
      git worktree prune 2>/dev/null || true
      log "Removed worktree: $worktree"
    fi

    # Reset current-task-N.md to idle
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

# --- Auto-supersede pending failed tasks that were re-completed ---
# When a task fails and gets re-implemented as a fresh task, the new task
# goes to completed.md while the old failed entry stays as status=pending.
# This detects such cases by normalizing core task titles (before " — "):
# strip tags, strip "FRESH implementation" suffix, lowercase, collapse
# whitespace, and compare the first 50 characters.
_auto_supersede_completed_tasks() {
  [ -f "$FAILED" ] || return 0
  [ -f "$COMPLETED" ] || return 0

  # Build list of completed core titles (text before " — "), then normalize
  local completed_raw
  completed_raw=$(awk -F'|' 'NR > 2 {
    t = $3; gsub(/^ +| +$/, "", t); sub(/ —.*/, "", t)
    if (t != "") print t
  }' "$COMPLETED")
  [ -z "$completed_raw" ] && return 0

  local completed_normalized=""
  while IFS= read -r _line; do
    local _norm
    _norm=$(_normalize_title "$_line")
    if [ -n "$_norm" ]; then
      completed_normalized="${completed_normalized}${_norm}
"
    fi
  done <<< "$completed_raw"
  [ -z "$completed_normalized" ] && return 0

  local updated=0

  # Scan pending entries in failed-tasks.md for matches in completed.md
  while IFS='|' read -r _ _date task branch _error _attempts status _; do
    status=$(echo "$status" | sed 's/^ *//;s/ *$//')
    [ "$status" = "pending" ] || continue

    task=$(echo "$task" | sed 's/^ *//;s/ *$//')
    branch=$(echo "$branch" | sed 's/^ *//;s/ *$//')

    # Extract core title (before first " — ") and normalize
    local core_title="${task%% —*}"
    [ -z "$core_title" ] && continue
    local norm_title
    norm_title=$(_normalize_title "$core_title")
    [ -z "$norm_title" ] && continue

    # Check if any completed task shares this normalized core title
    if echo "$completed_normalized" | grep -qxF "$norm_title"; then
      # Replace pending → superseded for this specific line (match by branch)
      awk -v br="$branch" '{
        if (index($0, br) > 0 && match($0, /\| *pending *\|/))
          sub(/\| *pending *\|/, "| superseded |")
        print
      }' "$FAILED" > "$FAILED.tmp" && mv "$FAILED.tmp" "$FAILED"
      updated=$((updated + 1))
      log "Auto-superseded: $core_title (branch: $branch, normalized match in completed.md)"
    fi
  done < <(tail -n +3 "$FAILED")

  if [ "$updated" -gt 0 ]; then
    log "Auto-superseded $updated failed task(s) completed via fresh implementation"
    tg "✅ *$SKYNET_PROJECT_NAME_UPPER WATCHDOG*: Auto-superseded $updated task(s) re-completed via fresh branch"
  fi
}

# --- Run auto-supersede before branch cleanup (so newly-superseded entries get cleaned) ---
_auto_supersede_completed_tasks

# --- Archive old completed tasks to prevent unbounded state file growth ---
# If completed.md has >100 entries, move entries older than 7 days to
# completed-archive.md, keeping only the most recent 100 in the active file.
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
    case "$branch" in dev/*) ;; *) continue ;; esac

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

# --- Run stale branch cleanup ---
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
  local score=100
  local threshold="${SKYNET_HEALTH_ALERT_THRESHOLD:-50}"
  local sentinel="/tmp/skynet-${SKYNET_PROJECT_NAME:-skynet}-health-alert-sent"

  # -5 per pending failed task
  local pending_failed=0
  if [ -f "$FAILED" ]; then
    pending_failed=$(grep -c '| pending |' "$FAILED" 2>/dev/null || true)
    pending_failed=${pending_failed:-0}
  fi
  score=$((score - pending_failed * 5))

  # -10 per active blocker (non-empty lines under ## Active in blockers.md)
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

  # -2 per stale heartbeat (counted earlier in the cycle)
  score=$((score - _stale_heartbeat_count * 2))

  # Clamp to 0-100
  [ "$score" -lt 0 ] && score=0
  [ "$score" -gt 100 ] && score=100

  if [ "$score" -lt "$threshold" ]; then
    # Only alert once per drop (sentinel prevents repeated alerts)
    if [ ! -f "$sentinel" ]; then
      emit_event "health_alert" "Health score: $score"
      tg "🚨 *$SKYNET_PROJECT_NAME_UPPER WATCHDOG*: Pipeline health alert: score $score/100 (threshold: $threshold)"
      date +%s > "$sentinel"
      log "Health alert: score $score/100 (pending_failed=$pending_failed, blockers=$active_blockers, stale_hb=$_stale_heartbeat_count)"
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

# --- Pipeline pause check (skip dispatch but still run health checks above) ---
pipeline_paused=false
if [ -f "$DEV_DIR/pipeline-paused" ]; then
  pipeline_paused=true
  log "Pipeline is paused. Skipping worker dispatch."
fi

# --- Only kick Claude-dependent workers if auth is OK ---
if $agent_auth_ok && ! $pipeline_paused; then
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
if [ -f "$DEV_DIR/fixer-stats.log" ]; then
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

) || log "Watchdog cycle failed (exit $?) — will retry next cycle"

# --- End of cycle — sleep before next iteration ---
sleep "$WATCHDOG_INTERVAL"

done  # end main loop
