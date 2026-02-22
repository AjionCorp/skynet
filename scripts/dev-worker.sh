#!/usr/bin/env bash
# dev-worker.sh — Pick next task from backlog, implement it via Claude Code
# Flow: worktree -> implement -> quality gates (SKYNET_GATE_*) -> merge to main -> cleanup
# Uses git worktrees so multiple workers can run concurrently without conflicts.
# On failure: moves task to failed-tasks.md, then tries the NEXT task
# Supports multiple workers: pass worker ID as arg (default: 1)
#   bash dev-worker.sh      → worker 1
#   bash dev-worker.sh 2    → worker 2
set -euo pipefail

# Worker ID (1 or 2)
WORKER_ID="${1:-1}"

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_config.sh"

# Per-worker port offset to prevent dev-server collisions in multi-worker mode
WORKER_PORT=$((SKYNET_DEV_PORT + WORKER_ID - 1))
export PORT="$WORKER_PORT"
WORKER_DEV_URL="http://localhost:${WORKER_PORT}"

LOG="$SCRIPTS_DIR/dev-worker-${WORKER_ID}.log"
STALE_MINUTES="$SKYNET_STALE_MINUTES"
MAX_TASKS_PER_RUN="$SKYNET_MAX_TASKS_PER_RUN"

# One-shot mode: run a single provided task, skip backlog
if [ "${SKYNET_ONE_SHOT:-}" = "true" ]; then
  MAX_TASKS_PER_RUN=1
fi

# Shared lock dir for atomic backlog access (mkdir is atomic on all Unix)
BACKLOG_LOCK="${SKYNET_LOCK_PREFIX}-backlog.lock"

# Per-worker task file (worker 1 → current-task-1.md, worker 2 → current-task-2.md)
WORKER_TASK_FILE="$DEV_DIR/current-task-${WORKER_ID}.md"

# One-shot mode uses a dedicated task file
if [ "${SKYNET_ONE_SHOT:-}" = "true" ]; then
  WORKER_TASK_FILE="$DEV_DIR/current-task-run.md"
fi

# Per-worker worktree directory (isolated from other workers)
WORKTREE_DIR="${SKYNET_WORKTREE_BASE}/w${WORKER_ID}"

cd "$PROJECT_DIR"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [W${WORKER_ID}] $*" >> "$LOG"; }

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
# Background loop writes epoch timestamp to .dev/worker-N.heartbeat every 60s
# so the watchdog can detect stuck workers even if the process is alive.
HEARTBEAT_FILE="$DEV_DIR/worker-${WORKER_ID}.heartbeat"
_heartbeat_pid=""

_start_heartbeat() {
  (
    while true; do
      date +%s > "$HEARTBEAT_FILE"
      db_update_heartbeat "$WORKER_ID" 2>/dev/null || true
      sleep 60
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
  rm -f "$HEARTBEAT_FILE"
}

# --- Mutex helpers using mkdir (works on macOS + Linux) ---
acquire_lock() {
  local attempts=0
  while ! mkdir "$BACKLOG_LOCK" 2>/dev/null; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 50 ]; then
      # Check for stale lock (older than 30s)
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

# --- Helper: check if a task's blockedBy dependencies are all done ---
# Usage: is_task_blocked "- [ ] [TAG] Title | blockedBy: Dep1, Dep2"
# Returns 0 (true) if blocked, 1 (false) if unblocked.
is_task_blocked() {
  local task_line="$1"
  # Extract blockedBy metadata (case-insensitive match after " | blockedBy: ")
  local blocked_by
  blocked_by=$(echo "$task_line" | sed -n 's/.*| *[bB]locked[bB]y: *\(.*\)$/\1/p')
  if [ -z "$blocked_by" ]; then
    return 1  # no dependencies — not blocked
  fi
  # Extract own title (strip checkbox, tag, description, and blockedBy metadata)
  local own_title
  own_title=$(echo "$task_line" | sed 's/^- \[.\] //;s/^\[[^]]*\] //;s/ | [bB]locked[bB]y:.*//;s/ —.*//')
  # Split on comma and check each dependency
  local IFS=','
  for dep in $blocked_by; do
    dep=$(echo "$dep" | sed 's/^ *//;s/ *$//')  # trim whitespace
    if [ -z "$dep" ]; then continue; fi
    # Skip self-references (task cannot block itself)
    if [ "$dep" = "$own_title" ]; then continue; fi
    # Check if this dependency is done (has [x] marker) in the backlog
    # Match: "- [x] [TAG] <dep>" or "- [x] <dep>" anywhere in the title portion
    if ! grep -F "$dep" "$BACKLOG" 2>/dev/null | grep -qF "- [x]"; then
      # Fallback: check completed.md (dependencies may have been archived)
      if [ -f "$COMPLETED" ] && grep -qF "$dep" "$COMPLETED" 2>/dev/null; then
        continue
      fi
      return 0  # dependency not done — task is blocked
    fi
  done
  return 1  # all dependencies done — not blocked
}

# --- Helper: atomically claim the next unchecked task from backlog ---
# Uses mkdir lock to prevent two workers from grabbing the same task.
# Changes "- [ ]" to "- [>]" (claimed) so the other worker skips it.
# Skips tasks whose blockedBy dependencies are not yet completed.
# Outputs the claimed task line (original "- [ ] ..." form) or empty string.
claim_next_task() {
  if ! acquire_lock; then echo ""; return; fi
  local task=""
  # Iterate through all pending tasks, skip blocked ones
  while IFS= read -r candidate; do
    if ! is_task_blocked "$candidate"; then
      task="$candidate"
      break
    fi
  done < <(grep '^\- \[ \]' "$BACKLOG" 2>/dev/null || true)
  if [ -n "$task" ]; then
    if ! __AWK_TARGET="$task" awk 'BEGIN{target=ENVIRON["__AWK_TARGET"]} found == 0 && $0 == target {sub(/- \[ \]/, "- [>]"); found=1} {print}' \
      "$BACKLOG" > "$BACKLOG.tmp" || ! mv "$BACKLOG.tmp" "$BACKLOG"; then
      release_lock
      echo ""
      return
    fi
    release_lock
    echo "$task"
  else
    release_lock
  fi
}

# --- Helper: safely remove a line from backlog by exact match ---
remove_from_backlog() {
  local line_to_remove="$1"
  acquire_lock || return
  if [ -f "$BACKLOG" ]; then
    grep -Fxv -- "$line_to_remove" "$BACKLOG" > "$BACKLOG.tmp" || true
    mv "$BACKLOG.tmp" "$BACKLOG"
  fi
  release_lock
}

# --- Helper: mark a backlog item as checked (completed/failed) ---
mark_in_backlog() {
  local old_line="$1"
  local new_line="$2"
  local title="${old_line#- \[>\] }"
  acquire_lock || return
  if [ -f "$BACKLOG" ]; then
    __AWK_TITLE="$title" __AWK_NEW="$new_line" awk 'BEGIN{title=ENVIRON["__AWK_TITLE"]; new=ENVIRON["__AWK_NEW"]} {
      if ($0 == "- [>] " title || $0 == "- [ ] " title) print new
      else print
    }' "$BACKLOG" > "$BACKLOG.tmp"
    mv "$BACKLOG.tmp" "$BACKLOG"
  fi
  release_lock
}

# --- Helper: unclaim a task (revert [>] back to [ ]) ---
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

# --- Worktree helpers ---
# Each worker gets its own worktree directory so multiple workers can run
# on different branches without conflicting in the same working directory.

# Create a worktree for a feature branch. Installs deps via pnpm.
setup_worktree() {
  mkdir -p "$SKYNET_WORKTREE_BASE" 2>/dev/null || true
  local branch="$1"
  local from_main="${2:-true}"  # true = create new branch from main, false = use existing
  WORKTREE_LAST_ERROR=""

  # Clean any leftover worktree from previous runs
  cleanup_worktree 2>/dev/null || true

  if $from_main; then
    if ! _wt_out=$(git worktree add "$WORKTREE_DIR" -b "$branch" "$SKYNET_MAIN_BRANCH" 2>&1); then
      log "Worktree add failed for $branch: $_wt_out"
      if echo "$_wt_out" | grep -qi "already used by worktree"; then
        WORKTREE_LAST_ERROR="branch_in_use"
      else
        WORKTREE_LAST_ERROR="worktree_add_failed"
      fi
      return 1
    fi
  else
    if ! _wt_out=$(git worktree add "$WORKTREE_DIR" "$branch" 2>&1); then
      log "Worktree add failed for existing branch $branch: $_wt_out"
      if echo "$_wt_out" | grep -qi "already used by worktree"; then
        WORKTREE_LAST_ERROR="branch_in_use"
      else
        WORKTREE_LAST_ERROR="worktree_add_failed"
      fi
      return 1
    fi
  fi
  if [ ! -d "$WORKTREE_DIR" ]; then
    log "Worktree directory missing after add: $WORKTREE_DIR"
    WORKTREE_LAST_ERROR="worktree_missing"
    return 1
  fi

  # Install dependencies (fast — pnpm content-addressable store is cached)
  log "Installing deps in worktree..."
  if ! (cd "$WORKTREE_DIR" && eval "${SKYNET_INSTALL_CMD:-pnpm install --frozen-lockfile}") >> "$LOG" 2>&1; then
    log "ERROR: Dependency install failed in worktree"
    WORKTREE_LAST_ERROR="install_failed"
    return 1
  fi
}

# Remove worktree. Optionally delete the branch too.
cleanup_worktree() {
  local delete_branch="${1:-}"
  cd "$PROJECT_DIR"  # ensure we're not inside the worktree
  if [ -d "$WORKTREE_DIR" ]; then
    git worktree remove "$WORKTREE_DIR" --force 2>/dev/null || rm -rf "$WORKTREE_DIR" 2>/dev/null || true
  fi
  git worktree prune 2>/dev/null || true
  if [ -n "$delete_branch" ]; then
    git branch -D "$delete_branch" 2>/dev/null || true
  fi
}

# --- PID lock to prevent duplicate runs (per worker ID, mkdir-based atomic lock) ---
LOCKFILE="${SKYNET_LOCK_PREFIX}-dev-worker-${WORKER_ID}.lock"
if mkdir "$LOCKFILE" 2>/dev/null; then
  echo $$ > "$LOCKFILE/pid"
else
  # Lock dir exists — check for stale lock (owner PID no longer running)
  if [ -d "$LOCKFILE" ] && [ -f "$LOCKFILE/pid" ]; then
    _existing_pid=$(cat "$LOCKFILE/pid" 2>/dev/null || echo "")
    if [ -n "$_existing_pid" ] && kill -0 "$_existing_pid" 2>/dev/null; then
      echo "[$(date '+%Y-%m-%d %H:%M:%S')] [W${WORKER_ID}] Already running (PID $_existing_pid). Exiting." >> "$LOG"
      exit 0
    fi
    # Stale lock — reclaim atomically
    rm -rf "$LOCKFILE" 2>/dev/null || true
    if mkdir "$LOCKFILE" 2>/dev/null; then
      echo $$ > "$LOCKFILE/pid"
    else
      echo "[$(date '+%Y-%m-%d %H:%M:%S')] [W${WORKER_ID}] Lock contention. Exiting." >> "$LOG"
      exit 0
    fi
  else
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] [W${WORKER_ID}] Lock contention. Exiting." >> "$LOG"
    exit 0
  fi
fi
# Track current task for cleanup on unexpected exit
_CURRENT_TASK_TITLE=""
cleanup_on_exit() {
  # Stop heartbeat writer
  _stop_heartbeat 2>/dev/null || true
  # Release merge lock if held
  release_merge_lock 2>/dev/null || true
  # Clean up worktree if it exists
  cleanup_worktree 2>/dev/null || true
  # Unclaim task if we were in the middle of one
  if [ -n "$_CURRENT_TASK_TITLE" ]; then
    if [ "${SKYNET_ONE_SHOT:-}" != "true" ]; then
      db_unclaim_task_by_title "$_CURRENT_TASK_TITLE" 2>/dev/null || true
      unclaim_task "$_CURRENT_TASK_TITLE" 2>/dev/null || true
    fi
    db_set_worker_idle "$WORKER_ID" "Unexpected exit — $_CURRENT_TASK_TITLE" 2>/dev/null || true
    log "Unexpected exit — unclaimed task: $_CURRENT_TASK_TITLE"
  fi
  rm -rf "$LOCKFILE"
}
trap cleanup_on_exit EXIT
trap 'log "ERR on line $LINENO"; exit 1' ERR

# --- Graceful shutdown handling ---
# When SIGTERM/SIGINT is received (e.g. from `skynet stop`), set a flag so we
# can finish the current phase cleanly and exit at the next safe checkpoint.
# This prevents mid-merge kills from leaving branches in inconsistent state.
SHUTDOWN_REQUESTED=false
trap 'SHUTDOWN_REQUESTED=true; log "Shutdown signal received — will exit at next checkpoint"' SIGTERM SIGINT

# --- Pipeline pause check ---
if [ -f "$DEV_DIR/pipeline-paused" ]; then
  log "Pipeline paused — exiting"
  exit 0
fi

# --- Claude Code auth pre-check (with alerting) ---
source "$SCRIPTS_DIR/auth-check.sh"
if ! check_any_auth; then
  log "No agent auth available (Claude/Codex). Skipping worker."
  exit 1
fi

# --- Ensure dev server is running with log capture ---
SERVER_LOG="$SCRIPTS_DIR/next-dev-w${WORKER_ID}.log"
SERVER_PID_FILE="$SCRIPTS_DIR/next-dev-w${WORKER_ID}.pid"
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
    # SQLite: fail the task if we can find its ID
    _stale_id=$(db_get_task_id_by_title "$task_title" 2>/dev/null || true)
    if [ -n "$_stale_id" ]; then
      db_fail_task "$_stale_id" "--" "Stale lock after ${age_minutes}m" || true
    fi
    echo "| $(date '+%Y-%m-%d') | $task_title | -- | Stale lock after ${age_minutes}m | 0 | pending |" >> "$FAILED"
    remove_from_backlog "- [>] $task_title"
    # Fallback: also try [x] in case another code path already marked it done
    remove_from_backlog "- [x] $task_title"
  fi
fi

# --- Task loop ---
tasks_attempted=0
tasks_completed=0
tasks_failed=0
_one_shot_exit=0

while [ "$tasks_attempted" -lt "$MAX_TASKS_PER_RUN" ]; do
  tasks_attempted=$((tasks_attempted + 1))

  # Update progress epoch — proves the main loop is making forward progress
  # (distinct from heartbeat which runs in a background subshell)
  db_update_progress "$WORKER_ID" 2>/dev/null || true

  # Rotate log if it exceeds max size (prevents unbounded growth)
  rotate_log_if_needed "$LOG"

  # --- Graceful shutdown checkpoint ---
  if $SHUTDOWN_REQUESTED; then
    log "Shutdown requested, exiting cleanly"
    break
  fi

  # Atomically claim next unchecked task (or use provided task in one-shot mode)
  if [ "${SKYNET_ONE_SHOT:-}" = "true" ]; then
    next_task="- [ ] ${SKYNET_ONE_SHOT_TASK}"
    _db_task_id=""
  else
    _db_result=$(db_claim_next_task "$WORKER_ID")
    if [ -n "$_db_result" ]; then
      _db_task_id=$(echo "$_db_result" | cut -d$'\x1f' -f1)
      _db_title=$(echo "$_db_result" | cut -d$'\x1f' -f2)
      _db_tag=$(echo "$_db_result" | cut -d$'\x1f' -f3)
      next_task="- [ ] [${_db_tag}] ${_db_title}"
      # Backward compat: also mark [>] in backlog file
      acquire_lock && {
        if [ -f "$BACKLOG" ]; then
          __AWK_TITLE="$_db_title" awk 'BEGIN{title=ENVIRON["__AWK_TITLE"]} {
            if (index($0, title) > 0 && index($0, "- [ ]") == 1) sub(/- \[ \]/, "- [>]")
            print
          }' "$BACKLOG" > "$BACKLOG.tmp" && mv "$BACKLOG.tmp" "$BACKLOG"
        fi
        release_lock
      }
    else
      next_task=""
      _db_task_id=""
    fi
  fi
  if [ -z "$next_task" ]; then
    log "Backlog empty. Kicking off project-driver to refill."
    db_set_worker_idle "$WORKER_ID" "Backlog empty — project-driver kicked off" 2>/dev/null || true
    cat > "$WORKER_TASK_FILE" <<EOF
# Current Task
**Status:** idle
**Updated:** $(date '+%Y-%m-%d %H:%M')
**Note:** Backlog empty — project-driver kicked off to replenish
EOF
    # Kick off project-driver if not already running
    if ! ([ -f "${SKYNET_LOCK_PREFIX}-project-driver.lock/pid" ] && kill -0 "$(cat "${SKYNET_LOCK_PREFIX}-project-driver.lock/pid")" 2>/dev/null); then
      nohup bash "$SCRIPTS_DIR/project-driver.sh" >> "$SCRIPTS_DIR/project-driver.log" 2>&1 &
      log "Project-driver launched (PID $!)."
      tg "📋 *WATCHDOG*: Backlog empty — project-driver kicked off to replenish"
    else
      log "Project-driver already running."
    fi
    break
  fi

  # Extract task details
  task_title=$(echo "$next_task" | sed 's/^- \[ \] //')
  _CURRENT_TASK_TITLE="$task_title"
  # shellcheck disable=SC2034
  task_type=$(echo "$task_title" | grep -o '^\[.*\]' | tr -d '[]')
  branch_name="${SKYNET_BRANCH_PREFIX}$(echo "$task_title" | sed 's/^\[.*\] //' | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | tr -cd 'a-z0-9-' | head -c 40)"

  # Load skills matching this task's tag
  SKILL_CONTENT="$(get_skills_for_tag "${task_type:-}")"

  log "Starting task ($tasks_attempted/$MAX_TASKS_PER_RUN): $task_title"
  log "Branch: $branch_name"
  tg "🔨 *$SKYNET_PROJECT_NAME_UPPER W${WORKER_ID}* starting: $task_title"
  emit_event "task_claimed" "Worker $WORKER_ID: $task_title"

  # Write current task status for this worker
  task_start_epoch=$(date +%s)
  db_set_worker_status "$WORKER_ID" "dev" "in_progress" "${_db_task_id:-}" "$task_title" "$branch_name" 2>/dev/null || true
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
        [ -n "${_db_task_id:-}" ] && db_unclaim_task "$_db_task_id" 2>/dev/null || true
        unclaim_task "$task_title"
        _CURRENT_TASK_TITLE=""
        break
      fi
      log "Failed to create worktree for existing branch $branch_name — unclaiming."
      _stop_heartbeat
      cleanup_worktree "$branch_name"
      [ -n "${_db_task_id:-}" ] && db_unclaim_task "$_db_task_id" 2>/dev/null || true
      unclaim_task "$task_title"
      _CURRENT_TASK_TITLE=""
      continue
    fi
    log "Reusing existing branch $branch_name in worktree"
  else
    # Create new feature branch from main
    if ! setup_worktree "$branch_name" true; then
      if [ "${WORKTREE_LAST_ERROR:-}" = "branch_in_use" ]; then
        log "Branch $branch_name is already checked out in another worktree — skipping for now."
        _stop_heartbeat
        [ -n "${_db_task_id:-}" ] && db_unclaim_task "$_db_task_id" 2>/dev/null || true
        unclaim_task "$task_title"
        _CURRENT_TASK_TITLE=""
        break
      fi
      log "Failed to create worktree for $branch_name — unclaiming."
      _stop_heartbeat
      cleanup_worktree "$branch_name"
      [ -n "${_db_task_id:-}" ] && db_unclaim_task "$_db_task_id" 2>/dev/null || true
      unclaim_task "$task_title"
      _CURRENT_TASK_TITLE=""
      continue
    fi
  fi
  log "Worktree ready at $WORKTREE_DIR"

  # --- Implementation via Claude Code (runs in isolated worktree) ---
  PROMPT="You are working on the ${SKYNET_PROJECT_NAME} project at $WORKTREE_DIR.

Your task: $task_title

${SKYNET_WORKER_CONTEXT:-}
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

  (cd "$WORKTREE_DIR" && run_agent "$PROMPT" "$LOG") && exit_code=0 || exit_code=$?
  _stop_heartbeat
  if [ "$exit_code" -eq 124 ]; then
    log "Agent timed out after ${SKYNET_AGENT_TIMEOUT_MINUTES}m"
    tg "⏰ *$SKYNET_PROJECT_NAME_UPPER W${WORKER_ID}*: Agent timed out after ${SKYNET_AGENT_TIMEOUT_MINUTES}m — $task_title"
  fi
  if [ "$exit_code" -ne 0 ]; then
    log "Claude Code FAILED (exit $exit_code): $task_title"
    tg "❌ *$SKYNET_PROJECT_NAME_UPPER W${WORKER_ID} FAILED*: $task_title (claude exit $exit_code)"
    emit_event "task_failed" "Worker $WORKER_ID: $task_title"
    tasks_failed=$((tasks_failed + 1))
    cleanup_worktree "$branch_name"
    [ -n "${_db_task_id:-}" ] && db_fail_task "$_db_task_id" "$branch_name" "claude exit code $exit_code" || true
    db_set_worker_idle "$WORKER_ID" "Last failure: $task_title (claude failed)" 2>/dev/null || true
    if [ "${SKYNET_ONE_SHOT:-}" != "true" ]; then
      echo "| $(date '+%Y-%m-%d') | $task_title | $branch_name | claude exit code $exit_code | 0 | pending |" >> "$FAILED"
      mark_in_backlog "- [>] $task_title" "- [x] $task_title _(claude failed)_"
    fi
    _CURRENT_TASK_TITLE=""
    _one_shot_exit=1
    cat > "$WORKER_TASK_FILE" <<EOF
# Current Task
**Status:** idle
**Last failure:** $(date '+%Y-%m-%d %H:%M') -- $task_title (claude failed)
EOF
    log "Moved to failed-tasks. Trying next..."
    continue
  fi

  log "Claude Code completed. Running checks before merge..."

  if [ ! -d "$WORKTREE_DIR" ]; then
    log "Worktree missing before gates — re-adding $branch_name"
    if ! setup_worktree "$branch_name" false; then
      log "Failed to re-add worktree for $branch_name — recording failure."
      tg "❌ *$SKYNET_PROJECT_NAME_UPPER W${WORKER_ID} FAILED*: $task_title (worktree missing)"
      emit_event "task_failed" "Worker $WORKER_ID: $task_title (worktree missing)"
      tasks_failed=$((tasks_failed + 1))
      cleanup_worktree "$branch_name"
      [ -n "${_db_task_id:-}" ] && db_fail_task "$_db_task_id" "$branch_name" "worktree missing before gates" || true
      db_set_worker_idle "$WORKER_ID" "Last failure: $task_title (worktree missing)" 2>/dev/null || true
      if [ "${SKYNET_ONE_SHOT:-}" != "true" ]; then
        echo "| $(date '+%Y-%m-%d') | $task_title | $branch_name | worktree missing before gates | 0 | pending |" >> "$FAILED"
        mark_in_backlog "- [>] $task_title" "- [x] $task_title _(worktree missing)_"
      fi
      _CURRENT_TASK_TITLE=""
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
      (cd "$WORKTREE_DIR" && eval "${SKYNET_INSTALL_CMD:-pnpm install --frozen-lockfile}") >> "$LOG" 2>&1
    fi
  fi

  _gate_failed=""
  _gate_idx=1
  while true; do
    _gate_var="SKYNET_GATE_${_gate_idx}"
    _gate_cmd="${!_gate_var:-}"
    if [ -z "$_gate_cmd" ]; then break; fi
    log "Running gate $_gate_idx: $_gate_cmd"
    if ! (cd "$WORKTREE_DIR" && eval "$_gate_cmd") >> "$LOG" 2>&1; then
      _gate_failed="$_gate_cmd"
      break
    fi
    log "Gate $_gate_idx passed."
    _gate_idx=$((_gate_idx + 1))
  done

  if [ -n "$_gate_failed" ]; then
    _gate_label=$(echo "$_gate_failed" | awk '{print $NF}')
    log "GATE FAILED: $_gate_failed. Branch NOT merged."
    tg "❌ *$SKYNET_PROJECT_NAME_UPPER W${WORKER_ID} FAILED*: $task_title ($_gate_label failed)"
    emit_event "task_failed" "Worker $WORKER_ID: $task_title (gate: $_gate_label)"
    tasks_failed=$((tasks_failed + 1))
    cleanup_worktree  # Keep branch for task-fixer
    [ -n "${_db_task_id:-}" ] && db_fail_task "$_db_task_id" "$branch_name" "$_gate_label failed" || true
    db_set_worker_idle "$WORKER_ID" "Last failure: $task_title ($_gate_label failed)" 2>/dev/null || true
    if [ "${SKYNET_ONE_SHOT:-}" != "true" ]; then
      echo "| $(date '+%Y-%m-%d') | $task_title | $branch_name | $_gate_label failed | 0 | pending |" >> "$FAILED"
      mark_in_backlog "- [>] $task_title" "- [x] $task_title _($_gate_label failed)_"
    fi
    _CURRENT_TASK_TITLE=""
    _one_shot_exit=1
    cat > "$WORKER_TASK_FILE" <<EOF
# Current Task
**Status:** idle
**Last failure:** $(date '+%Y-%m-%d %H:%M') -- $task_title ($_gate_label failed, branch kept)
EOF
    log "Moved to failed-tasks. Branch $branch_name kept for task-fixer."
    continue
  fi

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
    [ -n "${_db_task_id:-}" ] && db_fail_task "$_db_task_id" "$branch_name" "bash-n failed" || true
    db_set_worker_idle "$WORKER_ID" "Last failure: $task_title (bash-n failed)" 2>/dev/null || true
    if [ "${SKYNET_ONE_SHOT:-}" != "true" ]; then
      echo "| $(date '+%Y-%m-%d') | $task_title | $branch_name | bash-n failed | 0 | pending |" >> "$FAILED"
      mark_in_backlog "- [>] $task_title" "- [x] $task_title _(bash-n failed)_"
    fi
    _CURRENT_TASK_TITLE=""
    _one_shot_exit=1
    continue
  fi

  # --- Non-blocking: Check server logs for runtime errors ---
  if [ -f "$SERVER_LOG" ]; then
    log "Checking server logs for runtime errors..."
    bash "$SCRIPTS_DIR/check-server-errors.sh" "$SCRIPTS_DIR/next-dev-w${WORKER_ID}.log" >> "$LOG" 2>&1 || \
      log "Server errors found -- written to blockers.md (non-blocking for merge)"
  fi

  # --- Graceful shutdown checkpoint (before merge) ---
  if $SHUTDOWN_REQUESTED; then
    log "Shutdown requested before merge — unclaiming task and exiting cleanly"
    [ -n "${_db_task_id:-}" ] && db_unclaim_task "$_db_task_id" 2>/dev/null || true
    unclaim_task "$task_title"
    _CURRENT_TASK_TITLE=""
    cleanup_worktree "$branch_name"
    break
  fi

  # --- All gates passed -- merge to main ---
  log "All checks passed. Merging $branch_name into $SKYNET_MAIN_BRANCH."

  # Acquire merge mutex — prevents concurrent merge races between workers/fixers
  if ! acquire_merge_lock; then
    _ml_holder=""
    [ -f "$MERGE_LOCK/pid" ] && _ml_holder=$(cat "$MERGE_LOCK/pid" 2>/dev/null || echo "unknown")
    log "Could not acquire merge lock — held by PID ${_ml_holder:-unknown}. Retrying task later."
    emit_event "merge_lock_contention" "Worker $WORKER_ID: $task_title (lock held by PID ${_ml_holder:-unknown})"
    [ -n "${_db_task_id:-}" ] && db_unclaim_task "$_db_task_id" 2>/dev/null || true
    unclaim_task "$task_title"
    _CURRENT_TASK_TITLE=""
    cleanup_worktree "$branch_name"
    continue
  fi

  # Remove worktree first (branch stays), then merge from main repo
  cleanup_worktree
  cd "$PROJECT_DIR"
  if ! git_pull_with_retry; then
    log "Cannot pull main — skipping merge, unclaiming task."
    [ -n "${_db_task_id:-}" ] && db_unclaim_task "$_db_task_id" 2>/dev/null || true
    unclaim_task "$task_title"
    _CURRENT_TASK_TITLE=""
    release_merge_lock
    continue
  fi

  _merge_succeeded=false
  if git merge "$branch_name" --no-edit 2>>"$LOG"; then
    _merge_succeeded=true
  else
    # Merge failed — attempt rebase recovery (max 1 attempt)
    log "Merge conflict — attempting rebase recovery..."
    git merge --abort 2>/dev/null || true
    git_pull_with_retry 2 || true
    git checkout "$branch_name" 2>>"$LOG"
    if git rebase "$SKYNET_MAIN_BRANCH" 2>>"$LOG"; then
      log "Rebase succeeded — retrying merge."
      git checkout "$SKYNET_MAIN_BRANCH" 2>>"$LOG"
      if git merge "$branch_name" --no-edit 2>>"$LOG"; then
        _merge_succeeded=true
      else
        log "Merge still fails after successful rebase — conflict files: $(git diff --name-only --diff-filter=U 2>/dev/null | tr '\n' ' ')"
        git merge --abort 2>/dev/null || true
      fi
    else
      log "Rebase has conflicts — aborting. Conflict files: $(git diff --name-only --diff-filter=U 2>/dev/null | tr '\n' ' ')"
      git rebase --abort 2>/dev/null || true
      git checkout "$SKYNET_MAIN_BRANCH" 2>>"$LOG"
    fi
  fi

  if ! $_merge_succeeded; then
    log "MERGE FAILED for $branch_name — moving to failed."
    emit_event "merge_conflict" "Worker $WORKER_ID: $task_title on $branch_name"
    tasks_failed=$((tasks_failed + 1))
    [ -n "${_db_task_id:-}" ] && db_fail_task "$_db_task_id" "$branch_name" "merge conflict" || true
    if [ "${SKYNET_ONE_SHOT:-}" != "true" ]; then
      echo "| $(date '+%Y-%m-%d') | $task_title | $branch_name | merge conflict | 0 | pending |" >> "$FAILED"
      mark_in_backlog "- [>] $task_title" "- [x] $task_title _(merge failed)_"
    fi
    _CURRENT_TASK_TITLE=""
    _one_shot_exit=1
    release_merge_lock
    tg "❌ *$SKYNET_PROJECT_NAME_UPPER W${WORKER_ID}*: merge failed for $task_title"
    continue
  fi
  git branch -d "$branch_name" 2>/dev/null || true

  task_duration_secs=$(( $(date +%s) - task_start_epoch ))
  task_duration=$(format_duration $task_duration_secs)
  # SQLite: mark task completed
  if [ -n "${_db_task_id:-}" ]; then
    db_complete_task "$_db_task_id" "merged to $SKYNET_MAIN_BRANCH" "$task_duration" "$task_duration_secs" "success" || true
  fi
  db_set_worker_status "$WORKER_ID" "dev" "completed" "${_db_task_id:-}" "$task_title" "$branch_name" 2>/dev/null || true
  if [ "${SKYNET_ONE_SHOT:-}" != "true" ]; then
    mark_in_backlog "- [>] $task_title" "- [x] $task_title"
    echo "| $(date '+%Y-%m-%d') | $task_title | merged to $SKYNET_MAIN_BRANCH | $task_duration | success |" >> "$COMPLETED"
  fi

  cat > "$WORKER_TASK_FILE" <<EOF
# Current Task
## $task_title
**Status:** completed
**Started:** $(date '+%Y-%m-%d %H:%M')
**Completed:** $(date '+%Y-%m-%d')
**Branch:** $branch_name
**Worker:** $WORKER_ID

### Changes
-- See git log for details
EOF

  # Commit pipeline status updates (skip in one-shot mode — task was never in backlog)
  if [ "${SKYNET_ONE_SHOT:-}" != "true" ]; then
    git add "$BACKLOG" "$WORKER_TASK_FILE" "$COMPLETED" "$FAILED" 2>/dev/null || true
    git commit -m "chore(${task_type:-pipeline}): $task_title" --no-verify 2>/dev/null || true
  fi

  # Clear task title AFTER state is committed — ensures cleanup_on_exit can
  # properly unclaim if worker crashes between merge and state commit
  _CURRENT_TASK_TITLE=""

  # --- Post-merge smoke test (if enabled) ---
  if [ "${SKYNET_POST_MERGE_SMOKE:-false}" = "true" ]; then
    log "Running post-merge smoke test..."
    if ! bash "$SKYNET_SCRIPTS_DIR/post-merge-smoke.sh" >> "$LOG" 2>&1; then
      log "SMOKE TEST FAILED — reverting merge"
      git revert HEAD --no-edit 2>>"$LOG"
      git add "$BACKLOG" "$WORKER_TASK_FILE" "$COMPLETED" "$FAILED" 2>/dev/null || true
      git commit -m "revert: auto-revert $task_title (smoke test failed)" --no-verify 2>/dev/null || true

      if [ "${SKYNET_ONE_SHOT:-}" != "true" ]; then
        mark_in_backlog "- [x] $task_title" "- [x] $task_title _(smoke failed)_"
        echo "| $(date '+%Y-%m-%d') | $task_title | $branch_name | smoke test failed | 0 | pending |" >> "$FAILED"
      fi
      # SQLite: revert from completed to failed
      [ -n "${_db_task_id:-}" ] && db_fail_task "$_db_task_id" "$branch_name" "smoke test failed" || true

      _CURRENT_TASK_TITLE=""
      _one_shot_exit=1
      release_merge_lock
      tg "🔄 *$SKYNET_PROJECT_NAME_UPPER W${WORKER_ID} REVERTED*: $task_title (smoke test failed)"
      emit_event "task_reverted" "Worker $WORKER_ID: $task_title (smoke test failed)"
      log "Merge reverted. Task moved to failed-tasks."
      continue
    fi
    log "Post-merge smoke test passed."
  fi

  # Push merged changes to origin (while still holding merge lock)
  if ! git_push_with_retry; then
    log "WARNING: git push failed — changes are merged locally but not on remote"
    tg "⚠️ *$SKYNET_PROJECT_NAME_UPPER W${WORKER_ID}*: push failed for $task_title — merged locally only"
  fi

  release_merge_lock

  log "Task completed and merged to $SKYNET_MAIN_BRANCH: $task_title"
  remaining=$(db_count_pending 2>/dev/null || grep -c '^\- \[ \]' "$BACKLOG" 2>/dev/null || echo 0)
  remaining=${remaining:-0}
  tg "✅ *$SKYNET_PROJECT_NAME_UPPER W${WORKER_ID} MERGED*: $task_title ($remaining tasks remaining)"
  emit_event "task_completed" "Worker $WORKER_ID: $task_title"
  tasks_completed=$((tasks_completed + 1))
done

log "Dev worker $WORKER_ID finished: $tasks_attempted attempted, $tasks_completed completed, $tasks_failed failed."
emit_event "worker_session_end" "Worker $WORKER_ID: $tasks_completed completed, $tasks_failed failed of $tasks_attempted attempted"

# In one-shot mode, propagate task failure as non-zero exit
if [ "${SKYNET_ONE_SHOT:-}" = "true" ] && [ "$_one_shot_exit" -ne 0 ]; then
  exit "$_one_shot_exit"
fi
