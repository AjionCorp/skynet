#!/usr/bin/env bash
# watchdog.sh — Lightweight dispatcher that prevents idle time
# Runs every 3 min via crontab. Checks if workers are idle with work waiting, kicks them off.
# Does NOT invoke Claude itself — just launches the worker scripts.
# Auth-aware: skips Claude-dependent workers when auth is expired.
# Crash recovery: detects stale locks, unclaims orphaned tasks, kills orphan processes.
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_config.sh"

LOG="$SCRIPTS_DIR/watchdog.log"
AUTH_NOTIFY_INTERVAL=3600

cd "$PROJECT_DIR"

# Trim logs to last 24h on each watchdog run
bash "$SCRIPTS_DIR/clean-logs.sh" 2>/dev/null || true

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }

is_running() {
  local lockfile="$1"
  [ -f "$lockfile" ] && kill -0 "$(cat "$lockfile")" 2>/dev/null
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
    awk -v title="$task_title" '{
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
  local all_locks=(
    "${SKYNET_LOCK_PREFIX}-dev-worker-1.lock"
    "${SKYNET_LOCK_PREFIX}-dev-worker-2.lock"
    "${SKYNET_LOCK_PREFIX}-task-fixer.lock"
    "${SKYNET_LOCK_PREFIX}-project-driver.lock"
  )

  for lockfile in "${all_locks[@]}"; do
    [ -f "$lockfile" ] || continue

    local lock_pid
    lock_pid=$(cat "$lockfile" 2>/dev/null || echo "")
    [ -z "$lock_pid" ] && { rm -f "$lockfile"; recovered=$((recovered + 1)); continue; }

    local stale=false

    if ! kill -0 "$lock_pid" 2>/dev/null; then
      # PID is dead — lock is stale (crash bypassed EXIT trap)
      stale=true
      log "Stale lock: $lockfile (PID $lock_pid dead)"
    else
      # PID alive — check if it's been running too long (zombie/hung worker)
      local lock_mtime
      lock_mtime=$(file_mtime "$lockfile")
      local lock_age_secs=$(( $(date +%s) - lock_mtime ))
      local stale_secs=$((SKYNET_STALE_MINUTES * 60))
      if [ "$lock_age_secs" -gt "$stale_secs" ]; then
        stale=true
        log "Zombie worker: $lockfile (PID $lock_pid, ${lock_age_secs}s old > ${stale_secs}s limit)"
        # Graceful kill first, then force
        kill -TERM "$lock_pid" 2>/dev/null || true
        sleep 2
        kill -0 "$lock_pid" 2>/dev/null && kill -9 "$lock_pid" 2>/dev/null || true
      fi
    fi

    if $stale; then
      rm -f "$lockfile"
      recovered=$((recovered + 1))
    fi
  done

  # Phase 2: Recover partial task states — unclaim [>] tasks from dead workers
  for wid in 1 2; do
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
    fi
  done

  # Also check for any [>] entries in backlog with no live worker at all
  if [ -f "$BACKLOG" ]; then
    local any_worker_alive=false
    for wid in 1 2; do
      is_running "${SKYNET_LOCK_PREFIX}-dev-worker-${wid}.lock" && any_worker_alive=true
    done
    is_running "${SKYNET_LOCK_PREFIX}-task-fixer.lock" && any_worker_alive=true

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
  local worktree_dirs=(
    "/tmp/skynet-${SKYNET_PROJECT_NAME}-worktree-w1:${SKYNET_LOCK_PREFIX}-dev-worker-1.lock"
    "/tmp/skynet-${SKYNET_PROJECT_NAME}-worktree-w2:${SKYNET_LOCK_PREFIX}-dev-worker-2.lock"
    "/tmp/skynet-${SKYNET_PROJECT_NAME}-worktree-fixer:${SKYNET_LOCK_PREFIX}-task-fixer.lock"
  )

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
# Read token from cache file (written by auth-refresh LaunchAgent)
claude_auth_ok=false
_access_token=""
[ -f "$SKYNET_AUTH_TOKEN_CACHE" ] && _access_token=$(cat "$SKYNET_AUTH_TOKEN_CACHE" 2>/dev/null)
if [ -n "$_access_token" ] && curl -sf -o /dev/null --max-time 10 \
     https://api.anthropic.com/api/oauth/claude_cli/roles \
     -H "Authorization: Bearer $_access_token" \
     -H "Content-Type: application/json"; then
  claude_auth_ok=true
  # Clear failure flag if it was set
  if [ -f "$SKYNET_AUTH_FAIL_FLAG" ]; then
    rm -f "$SKYNET_AUTH_FAIL_FLAG"
    log "Claude auth restored!"
    tg "✅ *$SKYNET_PROJECT_NAME_UPPER AUTH RESTORED* — Pipeline resuming."
    # Remove auth blocker
    if [ -f "$BLOCKERS" ]; then
      grep -v "Claude Code authentication expired" "$BLOCKERS" > "$BLOCKERS.tmp" 2>/dev/null || true
      mv "$BLOCKERS.tmp" "$BLOCKERS"
    fi
  fi
else
  # Auth failed — throttle Telegram alerts
  now_epoch=$(date +%s)
  should_notify=true
  if [ -f "$SKYNET_AUTH_FAIL_FLAG" ]; then
    last_notify=$(cat "$SKYNET_AUTH_FAIL_FLAG")
    elapsed=$((now_epoch - last_notify))
    [ "$elapsed" -lt "$AUTH_NOTIFY_INTERVAL" ] && should_notify=false
  fi
  if $should_notify; then
    echo "$now_epoch" > "$SKYNET_AUTH_FAIL_FLAG"
    log "Claude auth FAILED. Skipping Claude workers. Telegram alert sent."
    tg "🔴 *$SKYNET_PROJECT_NAME_UPPER AUTH DOWN* — Claude not authenticated. Pipeline paused. Run: claude then /login"
    if ! grep -q "Claude Code authentication expired" "$BLOCKERS" 2>/dev/null; then
      echo "- **$(date '+%Y-%m-%d %H:%M')**: Claude Code authentication expired. Run \`claude\` and \`/login\` to restore." >> "$BLOCKERS"
    fi
  else
    log "Claude auth still down. Skipping Claude workers. (alert throttled)"
  fi
fi

# Count backlog tasks (grep -c exits 1 on no match, so use || true and default)
backlog_count=$(grep -c '^\- \[ \]' "$BACKLOG" 2>/dev/null || true)
backlog_count=${backlog_count:-0}
backlog_count=$((backlog_count + 0))

# Count pending failed tasks
failed_pending=$(grep -c '| pending |' "$FAILED" 2>/dev/null || true)
failed_pending=${failed_pending:-0}
failed_pending=$((failed_pending + 0))

# Check worker states
w1_running=false
w2_running=false
fixer_running=false
driver_running=false

is_running "${SKYNET_LOCK_PREFIX}-dev-worker-1.lock" && w1_running=true
is_running "${SKYNET_LOCK_PREFIX}-dev-worker-2.lock" && w2_running=true
is_running "${SKYNET_LOCK_PREFIX}-task-fixer.lock" && fixer_running=true
is_running "${SKYNET_LOCK_PREFIX}-project-driver.lock" && driver_running=true

# --- Stale heartbeat detection ---
# If a worker is alive but its heartbeat is older than SKYNET_STALE_MINUTES,
# it's stuck. Kill it, unclaim its task, remove worktree, reset to idle.
_handle_stale_worker() {
  local wid="$1"
  local hb_file="$DEV_DIR/worker-${wid}.heartbeat"
  local lockfile="${SKYNET_LOCK_PREFIX}-dev-worker-${wid}.lock"
  local task_file="$DEV_DIR/current-task-${wid}.md"
  local worktree="/tmp/skynet-${SKYNET_PROJECT_NAME}-worktree-w${wid}"
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

    # Kill the worker process
    if [ -f "$lockfile" ]; then
      local wpid
      wpid=$(cat "$lockfile" 2>/dev/null || echo "")
      if [ -n "$wpid" ] && kill -0 "$wpid" 2>/dev/null; then
        kill "$wpid" 2>/dev/null || true
        sleep 2
        kill -9 "$wpid" 2>/dev/null || true
        log "Killed worker $wid (PID $wpid)"
      fi
      rm -f "$lockfile"
    fi

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
          awk -v title="$task_title" '{
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
  fi
}

# Check each worker for stale heartbeats
for _wid in $(seq 1 "${SKYNET_MAX_WORKERS:-2}"); do
  _handle_stale_worker "$_wid"
done

# Refresh worker running state after potential kills
w1_running=false; w2_running=false
is_running "${SKYNET_LOCK_PREFIX}-dev-worker-1.lock" && w1_running=true
is_running "${SKYNET_LOCK_PREFIX}-dev-worker-2.lock" && w2_running=true

# --- Only kick Claude-dependent workers if auth is OK ---
if $claude_auth_ok; then
  # Rule 1a: Backlog has tasks + worker 1 idle → kick off worker 1
  if [ "$backlog_count" -gt 0 ] && ! $w1_running; then
    log "Backlog has $backlog_count tasks, worker 1 idle. Kicking off."
    tg "👁 *WATCHDOG*: Kicking off dev-worker 1 ($backlog_count tasks waiting)"
    nohup bash "$SCRIPTS_DIR/dev-worker.sh" 1 >> "$SCRIPTS_DIR/dev-worker-1.log" 2>&1 &
  fi

  # Rule 1b: Backlog has 2+ tasks + worker 2 idle → kick off worker 2
  if [ "$backlog_count" -ge 2 ] && ! $w2_running; then
    log "Backlog has $backlog_count tasks (>=2), worker 2 idle. Kicking off."
    tg "👁 *WATCHDOG*: Kicking off dev-worker 2 ($backlog_count tasks waiting)"
    nohup bash "$SCRIPTS_DIR/dev-worker.sh" 2 >> "$SCRIPTS_DIR/dev-worker-2.log" 2>&1 &
  fi

  # Rule 2: Failed tasks pending + fixer idle → kick off task-fixer
  if [ "$failed_pending" -gt 0 ] && ! $fixer_running; then
    log "Failed tasks pending ($failed_pending), task-fixer idle. Kicking off."
    tg "👁 *WATCHDOG*: Kicking off task-fixer ($failed_pending failed tasks)"
    nohup bash "$SCRIPTS_DIR/task-fixer.sh" >> "$SCRIPTS_DIR/task-fixer.log" 2>&1 &
  fi

  # Rule 3: Kick off project-driver if needed (rate-limited)
  if ! $driver_running; then
    should_kick=false
    last_kick_file="${SKYNET_LOCK_PREFIX}-project-driver-last-kick"
    if [ "$backlog_count" -lt 5 ]; then
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
      nohup bash "$SCRIPTS_DIR/project-driver.sh" >> "$SCRIPTS_DIR/project-driver.log" 2>&1 &
    fi
  fi
fi
