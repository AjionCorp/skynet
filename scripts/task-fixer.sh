#!/usr/bin/env bash
# task-fixer.sh — Analyzes failed tasks, diagnoses root cause, attempts fixes
# Reads failed-tasks.md, picks the oldest pending failure, tries to resolve it
# Uses git worktrees for branch isolation (same as dev-worker.sh).
# Supports multiple instances: pass instance ID as arg (default: 1)
#   bash task-fixer.sh      → fixer 1
#   bash task-fixer.sh 2    → fixer 2
set -euo pipefail

FIXER_ID="${1:-1}"

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_config.sh"

# Instance-specific log: fixer 1 → task-fixer.log, fixer 2+ → task-fixer-N.log
if [ "$FIXER_ID" = "1" ]; then
  LOG="$SCRIPTS_DIR/task-fixer.log"
else
  LOG="$SCRIPTS_DIR/task-fixer-${FIXER_ID}.log"
fi
MAX_FIX_ATTEMPTS="$SKYNET_MAX_FIX_ATTEMPTS"
FIXER_STATS="$DEV_DIR/fixer-stats.log"
FIXER_COOLDOWN="$DEV_DIR/fixer-cooldown"

# Instance-specific worktree (isolated from dev-workers and other fixers)
WORKTREE_DIR="${SKYNET_WORKTREE_BASE}/fixer-${FIXER_ID}"

cd "$PROJECT_DIR"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [F${FIXER_ID}] $*" | tee -a "$LOG"; }

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

# --- Worktree helpers ---
setup_worktree() {
  mkdir -p "$SKYNET_WORKTREE_BASE" 2>/dev/null || true
  local branch="$1"
  local from_main="${2:-true}"
  WORKTREE_LAST_ERROR=""
  cleanup_worktree 2>/dev/null || true
  if $from_main; then
    # Delete stale fix branch if it exists (left over from a previous crashed attempt)
    if git show-ref --verify --quiet "refs/heads/$branch" 2>/dev/null; then
      log "Deleting stale branch $branch before creating worktree"
      git branch -D "$branch" 2>/dev/null || true
    fi
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
  log "Installing deps in worktree..."
  (cd "$WORKTREE_DIR" && eval "${SKYNET_INSTALL_CMD:-pnpm install --frozen-lockfile}") >> "$LOG" 2>&1
}

cleanup_worktree() {
  local delete_branch="${1:-}"
  cd "$PROJECT_DIR"
  if [ -d "$WORKTREE_DIR" ]; then
    git worktree remove "$WORKTREE_DIR" --force 2>/dev/null || rm -rf "$WORKTREE_DIR" 2>/dev/null || true
  fi
  git worktree prune 2>/dev/null || true
  if [ -n "$delete_branch" ]; then
    git branch -D "$delete_branch" 2>/dev/null || true
  fi
}

# --- Helper: update a line in failed-tasks.md by matching task title ---
update_failed_line() {
  local match_title="$1"
  local new_line="$2"
  if [ -f "$FAILED" ]; then
    # Match pending OR fixing-N status (fixer claims change pending → fixing-N)
    __AWK_TITLE="$match_title" __AWK_REPL="$new_line" awk \
      'BEGIN{title=ENVIRON["__AWK_TITLE"]; replacement=ENVIRON["__AWK_REPL"]} index($0, title) > 0 && (/\| pending \|/ || /\| fixing-[0-9]+ \|/) {print replacement; next} {print}' \
      "$FAILED" > "$FAILED.tmp"
    mv "$FAILED.tmp" "$FAILED"
  fi
}

# --- PID lock (instance-specific: fixer 1 → -task-fixer.lock, fixer 2+ → -task-fixer-N.lock) ---
if [ "$FIXER_ID" = "1" ]; then
  LOCKFILE="${SKYNET_LOCK_PREFIX}-task-fixer.lock"
else
  LOCKFILE="${SKYNET_LOCK_PREFIX}-task-fixer-${FIXER_ID}.lock"
fi
if mkdir "$LOCKFILE" 2>/dev/null; then
  echo $$ > "$LOCKFILE/pid"
else
  # Lock dir exists — check for stale lock (owner PID no longer running)
  if [ -d "$LOCKFILE" ] && [ -f "$LOCKFILE/pid" ]; then
    _existing_pid=$(cat "$LOCKFILE/pid" 2>/dev/null || echo "")
    if [ -n "$_existing_pid" ] && kill -0 "$_existing_pid" 2>/dev/null; then
      echo "[$(date '+%Y-%m-%d %H:%M:%S')] [F${FIXER_ID}] Already running (PID $_existing_pid). Exiting." >> "$LOG"
      exit 0
    fi
    # Stale lock — reclaim atomically
    rm -rf "$LOCKFILE" 2>/dev/null || true
    if mkdir "$LOCKFILE" 2>/dev/null; then
      echo $$ > "$LOCKFILE/pid"
    else
      echo "[$(date '+%Y-%m-%d %H:%M:%S')] [F${FIXER_ID}] Lock contention. Exiting." >> "$LOG"
      exit 0
    fi
  else
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] [F${FIXER_ID}] Lock contention. Exiting." >> "$LOG"
    exit 0
  fi
fi
# Track current task for cleanup on unexpected exit
_CURRENT_TASK_TITLE=""
# Mutex for atomic claiming of failed tasks (shared with other fixers)
FAILED_LOCK="${SKYNET_LOCK_PREFIX}-failed.lock"

_acquire_failed_lock() {
  local attempts=0
  while ! mkdir "$FAILED_LOCK" 2>/dev/null; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 50 ]; then
      if [ -d "$FAILED_LOCK" ]; then
        local lock_mtime
        lock_mtime=$(file_mtime "$FAILED_LOCK")
        local lock_age=$(( $(date +%s) - lock_mtime ))
        if [ "$lock_age" -gt 30 ]; then
          rm -rf "$FAILED_LOCK" 2>/dev/null || true
          mkdir "$FAILED_LOCK" 2>/dev/null && return 0
        fi
      fi
      return 1
    fi
    sleep 0.1
  done
  return 0
}

_release_failed_lock() {
  rmdir "$FAILED_LOCK" 2>/dev/null || rm -rf "$FAILED_LOCK" 2>/dev/null || true
}

cleanup_on_exit() {
  local exit_code=$?
  # Abort any in-progress git merge on the main branch
  cd "$PROJECT_DIR" 2>/dev/null || true
  if [ -f "$PROJECT_DIR/.git/MERGE_HEAD" ]; then
    git merge --abort 2>/dev/null || true
    log "Crash recovery: aborted in-progress merge"
  fi
  # Clean up worktree if it exists
  cleanup_worktree 2>/dev/null || true
  # Unclaim task if we were mid-fix (revert fixing-N back to pending)
  if [ -n "$_CURRENT_TASK_TITLE" ]; then
    if _acquire_failed_lock; then
      if [ -f "$FAILED" ]; then
        sed_inplace "s/| fixing-${FIXER_ID} |/| pending |/g" "$FAILED"
      fi
      _release_failed_lock
    fi
    log "Crash recovery: unclaimed task: $_CURRENT_TASK_TITLE"
  fi
  # Release PID lock
  rm -rf "$LOCKFILE"
  # Log crash event (only on abnormal exit)
  if [ "$exit_code" -ne 0 ]; then
    log "task-fixer crashed (exit $exit_code). Cleanup complete."
  fi
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
  log "No agent auth available (Claude/Codex). Skipping task-fixer."
  exit 1
fi

# --- Retry budget: check for consecutive failures before attempting a fix ---
if [ -f "$FIXER_STATS" ]; then
  _last5=$(tail -5 "$FIXER_STATS")
  _fail_count=0
  _total_count=0
  while IFS='|' read -r _epoch _result _title; do
    [ -z "$_epoch" ] && continue
    _total_count=$((_total_count + 1))
    [ "$_result" = "failure" ] && _fail_count=$((_fail_count + 1))
  done <<< "$_last5"
  if [ "$_total_count" -ge 5 ] && [ "$_fail_count" -ge 5 ]; then
    date +%s > "$FIXER_COOLDOWN"
    log "Fixer paused: 5 consecutive failures, cooling down 30min"
    rm -rf "$LOCKFILE"
    exit 0
  fi
fi

# --- Pre-flight: atomically claim next pending failed task ---

pending_failure=""
if _acquire_failed_lock; then
  # Find first pending failure that isn't maxed out
  while IFS= read -r _line; do
    [ -z "$_line" ] && continue
    _title=$(echo "$_line" | awk -F'|' '{gsub(/^[ \t]+|[ \t]+$/, "", $3); print $3}')
    _branch=$(echo "$_line" | awk -F'|' '{gsub(/^[ \t]+|[ \t]+$/, "", $4); print $4}')
    _error=$(echo "$_line" | awk -F'|' '{gsub(/^[ \t]+|[ \t]+$/, "", $5); print $5}')
    _attempts=$(echo "$_line" | awk -F'|' '{gsub(/^[ \t]+|[ \t]+$/, "", $6); print $6}')
    if ! echo "$_attempts" | grep -Eq '^[0-9]+$'; then
      _attempts=0
    fi
    if [ "$_attempts" -ge "$MAX_FIX_ATTEMPTS" ] 2>/dev/null; then
      log "Task '$_title' has reached max fix attempts ($MAX_FIX_ATTEMPTS). Marking as blocked."
      update_failed_line "$_title" "| $(date '+%Y-%m-%d') | $_title | $_branch | $_error | $_attempts | blocked |"
      echo "- **$(date '+%Y-%m-%d')**: Task '$_title' failed $MAX_FIX_ATTEMPTS times. Needs human review. Error: $_error" >> "$BLOCKERS"
      tg "🚫 *${SKYNET_PROJECT_NAME_UPPER} TASK-FIXER F${FIXER_ID}* task BLOCKED after $MAX_FIX_ATTEMPTS attempts — $_title"
      emit_event "task_blocked" "Fixer $FIXER_ID: $_title (max attempts)"
      continue
    fi
    pending_failure="$_line"
    break
  done < <(grep '| pending |' "$FAILED" 2>/dev/null || true)

  if [ -n "$pending_failure" ]; then
    # Mark as claimed by this fixer instance (pending → fixing-N)
    task_match_title=$(echo "$pending_failure" | awk -F'|' '{gsub(/^[ \t]+|[ \t]+$/, "", $3); print $3}')
    __AWK_TITLE="$task_match_title" __AWK_FID="$FIXER_ID" awk \
      'BEGIN{title=ENVIRON["__AWK_TITLE"]; fid=ENVIRON["__AWK_FID"]} index($0, title) > 0 && /\| pending \|/ && !done {sub(/\| pending \|/, "| fixing-" fid " |"); done=1} {print}' \
      "$FAILED" > "$FAILED.tmp" && mv "$FAILED.tmp" "$FAILED"
  fi
  _release_failed_lock
fi

if [ -z "$pending_failure" ]; then
  log "No pending failed tasks. Nothing to fix."
  exit 0
fi

# Extract failed task details
task_title=$(echo "$pending_failure" | awk -F'|' '{gsub(/^[ \t]+|[ \t]+$/, "", $3); print $3}')
branch_name=$(echo "$pending_failure" | awk -F'|' '{gsub(/^[ \t]+|[ \t]+$/, "", $4); print $4}')
error_summary=$(echo "$pending_failure" | awk -F'|' '{gsub(/^[ \t]+|[ \t]+$/, "", $5); print $5}')
fix_attempts=$(echo "$pending_failure" | awk -F'|' '{gsub(/^[ \t]+|[ \t]+$/, "", $6); print $6}')
if ! echo "$fix_attempts" | grep -Eq '^[0-9]+$'; then
  fix_attempts=0
fi

# Check if max attempts reached
if [ "$fix_attempts" -ge "$MAX_FIX_ATTEMPTS" ] 2>/dev/null; then
  log "Task '$task_title' has reached max fix attempts ($MAX_FIX_ATTEMPTS). Marking as blocked."
  update_failed_line "$task_title" "| $(date '+%Y-%m-%d') | $task_title | $branch_name | $error_summary | $fix_attempts | blocked |"
  # Add to blockers
  echo "- **$(date '+%Y-%m-%d')**: Task '$task_title' failed $MAX_FIX_ATTEMPTS times. Needs human review. Error: $error_summary" >> "$BLOCKERS"
  tg "🚫 *${SKYNET_PROJECT_NAME_UPPER} TASK-FIXER F${FIXER_ID}* task BLOCKED after $MAX_FIX_ATTEMPTS attempts — $task_title"
  emit_event "task_blocked" "Fixer $FIXER_ID: $task_title (max attempts)"
  log "Moved to blockers. Exiting."
  exit 0
fi

_CURRENT_TASK_TITLE="$task_title"
log "Attempting to fix: $task_title (attempt $((fix_attempts + 1))/$MAX_FIX_ATTEMPTS)"
tg "🔧 *$SKYNET_PROJECT_NAME_UPPER TASK-FIXER F${FIXER_ID}* starting — fixing: $task_title (attempt $((fix_attempts + 1))/$MAX_FIX_ATTEMPTS)"

# Rotate log if it exceeds max size (prevents unbounded growth)
rotate_log_if_needed "$LOG"

fix_start_epoch=$(date +%s)

# --- Set up worktree for the failed branch ---
_handle_worktree_failure() {
  log "Failed to create worktree for $branch_name (${WORKTREE_LAST_ERROR:-unknown}). Returning task to pending."
  update_failed_line "$task_title" "| $(date '+%Y-%m-%d') | $task_title | $branch_name | $error_summary | $fix_attempts | pending |"
  _CURRENT_TASK_TITLE=""
  exit 0
}

_make_fix_branch() {
  branch_name="fix/$(echo "$task_title" | sed 's/^\[.*\] //' | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | tr -cd 'a-z0-9-' | head -c 40)"
  if ! setup_worktree "$branch_name" true; then
    _handle_worktree_failure
  fi
}

if git show-ref --verify --quiet "refs/heads/$branch_name" 2>/dev/null; then
  # Check if branch is already checked out in another worktree (e.g. dev-worker)
  _branch_worktree=$(git worktree list --porcelain 2>/dev/null | grep -B2 "branch refs/heads/$branch_name" | head -1 | sed 's/^worktree //' || true)
  if [ -n "$_branch_worktree" ]; then
    log "Branch $branch_name is in use by worktree $_branch_worktree — creating fresh fix branch"
    _make_fix_branch
    log "Created fresh fix branch in worktree: $branch_name"
  else
    # Check if the branch can merge cleanly into main before reusing it
    _merge_base=$(git merge-base "$SKYNET_MAIN_BRANCH" "$branch_name" 2>/dev/null || true)
    if [ -n "$_merge_base" ] && git merge-tree "$_merge_base" "$SKYNET_MAIN_BRANCH" "$branch_name" 2>/dev/null | grep -q '<<<<<<<'; then
      log "Branch $branch_name has merge conflicts — creating fresh branch"
      git branch -D "$branch_name" 2>/dev/null || true
      _make_fix_branch
      log "Created fresh fix branch in worktree: $branch_name"
    else
      if ! setup_worktree "$branch_name" false; then
        _handle_worktree_failure
      fi
      log "Checked out existing branch in worktree: $branch_name"
    fi
  fi
else
  _make_fix_branch
  log "Created new fix branch in worktree: $branch_name"
fi

# Determine which worker originally ran the task using the branch name
# (branch names are safe for grep -F: only a-z0-9- after slugification)
worker_log=""

# Method 1: Check current-task-N.md files for the branch name
for _wid in $(seq 1 "${SKYNET_MAX_WORKERS:-4}"); do
  _task_file="$DEV_DIR/current-task-${_wid}.md"
  if [ -f "$_task_file" ] && grep -qF "$branch_name" "$_task_file" 2>/dev/null; then
    worker_log="$SCRIPTS_DIR/dev-worker-${_wid}.log"
    log "Matched failed task to worker $_wid via current-task-${_wid}.md"
    break
  fi
done

# Method 2: Search worker logs for the branch name (works after task-file reset)
if [ -z "$worker_log" ]; then
  for _wlog in "$SCRIPTS_DIR"/dev-worker-*.log; do
    [ -f "$_wlog" ] || continue
    if grep -qF "$branch_name" "$_wlog" 2>/dev/null; then
      worker_log="$_wlog"
      log "Matched failed task to log: $_wlog (via branch name)"
      break
    fi
  done
fi

# Method 3: Fall back to most recently modified worker log
if [ -z "$worker_log" ] || [ ! -f "$worker_log" ]; then
  worker_log=$(ls -t "$SCRIPTS_DIR"/dev-worker-*.log 2>/dev/null | head -1 || true)
  [ -n "$worker_log" ] && log "Falling back to most recent worker log: $worker_log"
fi

# Read relevant log context from the identified worker's log
previous_log=""
if [ -n "$worker_log" ] && [ -f "$worker_log" ]; then
  # Try to extract task-specific output using fixed-string grep (handles [TAG] titles)
  _task_context=$(tail -200 "$worker_log" 2>/dev/null | grep -F -A 50 "$task_title" | tail -80 || true)
  if [ -n "$_task_context" ]; then
    previous_log="$_task_context"
  else
    # Fall back to last 100 lines of the correct worker's log
    previous_log=$(tail -100 "$worker_log" 2>/dev/null || echo "No log context available")
  fi
else
  previous_log="No worker log files found"
fi

# Get git diff of what was changed on the failed branch vs main
previous_diff=$(cd "$PROJECT_DIR" && git diff "${SKYNET_MAIN_BRANCH}...${branch_name}" 2>/dev/null | head -500 || echo "No diff available (branch may have no changes yet)")

PROMPT="You are the task-fixer agent for the ${SKYNET_PROJECT_NAME} project at $WORKTREE_DIR.

A previous attempt to implement this task FAILED. Your job is to diagnose why and fix it.

## Failed Task
**Title:** $task_title
**Branch:** $branch_name
**Error:** $error_summary
**Previous attempts:** $fix_attempts

## Previous Failure
### Error Output (from worker log)
\`\`\`
$previous_log
\`\`\`

### Changes on Failed Branch (git diff main...$branch_name)
\`\`\`diff
$previous_diff
\`\`\`

## Instructions
1. Read the codebase to understand what was attempted (check the branch for partial work)
2. Diagnose the root cause of the failure
3. Fix the issue -- complete the implementation if it was partial, fix errors if it broke
4. Run '$SKYNET_TYPECHECK_CMD' to verify -- fix any type errors (up to 3 passes)
5. Stage and commit your fixes with a descriptive message
6. Do NOT modify any files in ${DEV_DIR##*/}/ -- those are managed by the pipeline

If this task is genuinely impossible right now (missing API key, external dependency, etc.):
- Write the specific blocker to $BLOCKERS with date and task name
- Do NOT leave broken code committed

${SKYNET_WORKER_CONVENTIONS:-}"

# --- Graceful shutdown checkpoint (before fix attempt) ---
if $SHUTDOWN_REQUESTED; then
  log "Shutdown requested before fix attempt — unclaiming and exiting cleanly"
  if _acquire_failed_lock; then
    if [ -f "$FAILED" ]; then
      sed_inplace "s/| fixing-${FIXER_ID} |/| pending |/g" "$FAILED"
    fi
    _release_failed_lock
  fi
  _CURRENT_TASK_TITLE=""
  cleanup_worktree "$branch_name"
  exit 0
fi

emit_event "fix_started" "Fixer $FIXER_ID: $task_title"
if (cd "$WORKTREE_DIR" && run_agent "$PROMPT" "$LOG"); then
  log "Task-fixer succeeded. Running quality gates before merge..."

  if [ ! -d "$WORKTREE_DIR" ]; then
    log "Worktree missing before gates — re-adding $branch_name"
    if ! setup_worktree "$branch_name" false; then
      _handle_worktree_failure
    fi
  fi

  # Clean .dev/ in worktree before gates
  (cd "$WORKTREE_DIR" && git checkout -- "${DEV_DIR##*/}/" 2>/dev/null || true)
  (cd "$WORKTREE_DIR" && git clean -fd test-results/ 2>/dev/null || true)

  # Run configurable quality gates
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
    cleanup_worktree  # Keep branch for next attempt
    new_attempts=$((fix_attempts + 1))
    update_failed_line "$task_title" "| $(date '+%Y-%m-%d') | $task_title | $branch_name | $_gate_label failed after fix attempt $new_attempts | $new_attempts | pending |"
    _CURRENT_TASK_TITLE=""
    echo "$(date +%s)|failure|$task_title" >> "$FIXER_STATS"
  else
    # --- Graceful shutdown checkpoint (before merge) ---
    if $SHUTDOWN_REQUESTED; then
      log "Shutdown requested before merge — reverting claim and exiting cleanly"
      cleanup_worktree  # Keep branch for next attempt
      new_attempts=$((fix_attempts + 1))
      update_failed_line "$task_title" "| $(date '+%Y-%m-%d') | $task_title | $branch_name | $error_summary | $new_attempts | pending |"
      _CURRENT_TASK_TITLE=""
      exit 0
    fi

    log "All quality gates passed. Merging $branch_name into $SKYNET_MAIN_BRANCH."
    cleanup_worktree  # Remove worktree, keep branch for merge
    cd "$PROJECT_DIR"
    git pull origin "$SKYNET_MAIN_BRANCH" 2>>"$LOG" || true

    _merge_succeeded=false
    _err_trap=$(trap -p ERR || true)
    trap - ERR
    set +e
    if git merge "$branch_name" --no-edit 2>>"$LOG"; then
      _merge_succeeded=true
    else
      # Merge failed — attempt rebase recovery (max 1 attempt)
      log "Merge conflict — attempting rebase recovery..."
      git merge --abort 2>/dev/null || true
      git pull origin "$SKYNET_MAIN_BRANCH" 2>>"$LOG" || true
      git checkout "$branch_name" 2>>"$LOG"
      if git rebase "$SKYNET_MAIN_BRANCH" 2>>"$LOG"; then
        log "Rebase succeeded — retrying merge."
        git checkout "$SKYNET_MAIN_BRANCH" 2>>"$LOG"
        if git merge "$branch_name" --no-edit 2>>"$LOG"; then
          _merge_succeeded=true
        else
          git merge --abort 2>/dev/null || true
        fi
      else
        log "Rebase has conflicts — aborting rebase recovery."
        git rebase --abort 2>/dev/null || true
        git checkout "$SKYNET_MAIN_BRANCH" 2>>"$LOG"
      fi
    fi
    set -e
    if [ -n "$_err_trap" ]; then
      eval "$_err_trap"
    fi

    if $_merge_succeeded; then
      git branch -d "$branch_name"

      update_failed_line "$task_title" "| $(date '+%Y-%m-%d') | $task_title | merged to $SKYNET_MAIN_BRANCH | $error_summary | $((fix_attempts + 1)) | fixed |"
      fix_duration=$(format_duration $(( $(date +%s) - fix_start_epoch )))
      echo "| $(date '+%Y-%m-%d') | $task_title | merged to $SKYNET_MAIN_BRANCH | $fix_duration | fixed (attempt $((fix_attempts + 1))) |" >> "$COMPLETED"

      _CURRENT_TASK_TITLE=""
      log "Fixed and merged to $SKYNET_MAIN_BRANCH: $task_title"
      tg "✅ *$SKYNET_PROJECT_NAME_UPPER FIXED*: $task_title (attempt $((fix_attempts + 1)))"
      emit_event "fix_succeeded" "Fixer $FIXER_ID: $task_title"
      echo "$(date +%s)|success|$task_title" >> "$FIXER_STATS"
    else
      log "MERGE FAILED for $branch_name after rebase recovery — keeping as failed."
      new_attempts=$((fix_attempts + 1))
      update_failed_line "$task_title" "| $(date '+%Y-%m-%d') | $task_title | $branch_name | merge conflict after fix attempt $new_attempts | $new_attempts | pending |"
      _CURRENT_TASK_TITLE=""
      tg "❌ *$SKYNET_PROJECT_NAME_UPPER FIX MERGE FAILED*: $task_title (attempt $new_attempts)"
      emit_event "fix_merge_failed" "Fixer $FIXER_ID: $task_title"
      echo "$(date +%s)|failure|$task_title" >> "$FIXER_STATS"
    fi
  fi
else
  exit_code=$?
  if [ "$exit_code" -eq 124 ]; then
    log "Agent timed out after ${SKYNET_AGENT_TIMEOUT_MINUTES}m"
    tg "⏰ *$SKYNET_PROJECT_NAME_UPPER TASK-FIXER F${FIXER_ID}*: Agent timed out after ${SKYNET_AGENT_TIMEOUT_MINUTES}m — $task_title"
  fi
  log "Task-fixer failed again (exit $exit_code): $task_title"
  tg "❌ *$SKYNET_PROJECT_NAME_UPPER FIX FAILED*: $task_title (attempt $((fix_attempts + 1)))"
  emit_event "fix_failed" "Fixer $FIXER_ID: $task_title"

  cleanup_worktree  # Keep branch for next attempt
  new_attempts=$((fix_attempts + 1))
  update_failed_line "$task_title" "| $(date '+%Y-%m-%d') | $task_title | $branch_name | $error_summary (fix attempt $new_attempts failed) | $new_attempts | pending |"

  _CURRENT_TASK_TITLE=""
  echo "$(date +%s)|failure|$task_title" >> "$FIXER_STATS"
fi

log "Task-fixer finished."
