#!/usr/bin/env bash
# task-fixer.sh — Analyzes failed tasks, diagnoses root cause, attempts fixes
# Reads failed-tasks.md, picks the oldest pending failure, tries to resolve it
# Uses git worktrees for branch isolation (same as dev-worker.sh).
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_config.sh"

LOG="$SCRIPTS_DIR/task-fixer.log"
MAX_FIX_ATTEMPTS="$SKYNET_MAX_FIX_ATTEMPTS"

# Worktree for task-fixer (isolated from dev-workers)
WORKTREE_DIR="/tmp/skynet-${SKYNET_PROJECT_NAME}-worktree-fixer"

cd "$PROJECT_DIR"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

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
  local branch="$1"
  local from_main="${2:-true}"
  cleanup_worktree 2>/dev/null || true
  if $from_main; then
    git worktree add "$WORKTREE_DIR" -b "$branch" "$SKYNET_MAIN_BRANCH"
  else
    git worktree add "$WORKTREE_DIR" "$branch"
  fi
  log "Installing deps in worktree..."
  (cd "$WORKTREE_DIR" && pnpm install --frozen-lockfile --prefer-offline) >> "$LOG" 2>&1
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
    awk -v title="$match_title" -v replacement="$new_line" \
      'index($0, title) > 0 && /\| pending \|/ {print replacement; next} {print}' \
      "$FAILED" > "$FAILED.tmp"
    mv "$FAILED.tmp" "$FAILED"
  fi
}

# --- PID lock ---
LOCKFILE="${SKYNET_LOCK_PREFIX}-task-fixer.lock"
if [ -f "$LOCKFILE" ] && kill -0 "$(cat "$LOCKFILE")" 2>/dev/null; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Already running (PID $(cat "$LOCKFILE")). Exiting." >> "$LOG"
  exit 0
fi
echo $$ > "$LOCKFILE"
# Track current task for cleanup on unexpected exit
_CURRENT_TASK_TITLE=""
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
  # Reset current task to idle if we were mid-task
  if [ -n "$_CURRENT_TASK_TITLE" ]; then
    cat > "$CURRENT_TASK" <<CLEANUP_EOF
# Current Task
**Status:** idle
**Last failure:** $(date '+%Y-%m-%d %H:%M') -- [FIX] $_CURRENT_TASK_TITLE (crash exit $exit_code)
CLEANUP_EOF
    log "Crash recovery: reset current-task to idle for: $_CURRENT_TASK_TITLE"
  fi
  # Release PID lock
  rm -f "$LOCKFILE"
  # Log crash event (only on abnormal exit)
  if [ "$exit_code" -ne 0 ]; then
    log "task-fixer crashed (exit $exit_code). Cleanup complete."
  fi
}
trap cleanup_on_exit EXIT
trap 'log "ERR on line $LINENO"; exit 1' ERR

# --- Claude Code auth pre-check (with alerting) ---
source "$SCRIPTS_DIR/auth-check.sh"
if ! check_claude_auth; then
  exit 1
fi

# --- Pre-flight ---

# Check if a task is already running
if grep -q "in_progress" "$CURRENT_TASK" 2>/dev/null; then
  log "Another task is in_progress. Exiting."
  exit 0
fi

# Check if there are pending failed tasks
pending_failure=$(grep '| pending |' "$FAILED" 2>/dev/null | head -1 || true)
if [ -z "$pending_failure" ]; then
  log "No pending failed tasks. Nothing to fix."
  exit 0
fi

# Extract failed task details
task_title=$(echo "$pending_failure" | awk -F'|' '{gsub(/^[ \t]+|[ \t]+$/, "", $3); print $3}')
branch_name=$(echo "$pending_failure" | awk -F'|' '{gsub(/^[ \t]+|[ \t]+$/, "", $4); print $4}')
error_summary=$(echo "$pending_failure" | awk -F'|' '{gsub(/^[ \t]+|[ \t]+$/, "", $5); print $5}')
fix_attempts=$(echo "$pending_failure" | awk -F'|' '{gsub(/^[ \t]+|[ \t]+$/, "", $6); print $6}')

# Check if max attempts reached
if [ "$fix_attempts" -ge "$MAX_FIX_ATTEMPTS" ] 2>/dev/null; then
  log "Task '$task_title' has reached max fix attempts ($MAX_FIX_ATTEMPTS). Marking as blocked."
  update_failed_line "$task_title" "| $(date '+%Y-%m-%d') | $task_title | $branch_name | $error_summary | $fix_attempts | blocked |"
  # Add to blockers
  echo "- **$(date '+%Y-%m-%d')**: Task '$task_title' failed $MAX_FIX_ATTEMPTS times. Needs human review. Error: $error_summary" >> "$BLOCKERS"
  log "Moved to blockers. Exiting."
  exit 0
fi

_CURRENT_TASK_TITLE="$task_title"
log "Attempting to fix: $task_title (attempt $((fix_attempts + 1))/$MAX_FIX_ATTEMPTS)"
tg "🔧 *$SKYNET_PROJECT_NAME_UPPER TASK-FIXER* starting — fixing: $task_title (attempt $((fix_attempts + 1))/$MAX_FIX_ATTEMPTS)"

# Lock current task
fix_start_epoch=$(date +%s)
cat > "$CURRENT_TASK" <<EOF
# Current Task
## [FIX] $task_title
**Status:** in_progress
**Started:** $(date '+%Y-%m-%d %H:%M')
**Branch:** $branch_name
**Mode:** task-fixer (attempt $((fix_attempts + 1))/$MAX_FIX_ATTEMPTS)
EOF

# --- Set up worktree for the failed branch ---
if git show-ref --verify --quiet "refs/heads/$branch_name" 2>/dev/null; then
  setup_worktree "$branch_name" false
  log "Checked out existing branch in worktree: $branch_name"
else
  branch_name="fix/$(echo "$task_title" | sed 's/^\[.*\] //' | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | tr -cd 'a-z0-9-' | head -c 40)"
  setup_worktree "$branch_name" true
  log "Created new fix branch in worktree: $branch_name"
fi

# Get recent log context for the failure
recent_log=$(tail -100 "$SCRIPTS_DIR/dev-worker-1.log" 2>/dev/null | grep -A 50 "$task_title" | tail -50 || echo "No log context available")

PROMPT="You are the task-fixer agent for the ${SKYNET_PROJECT_NAME} project at $WORKTREE_DIR.

A previous attempt to implement this task FAILED. Your job is to diagnose why and fix it.

## Failed Task
**Title:** $task_title
**Branch:** $branch_name
**Error:** $error_summary
**Previous attempts:** $fix_attempts

## Recent Log Context
\`\`\`
$recent_log
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

if (cd "$WORKTREE_DIR" && run_agent "$PROMPT" "$LOG"); then
  log "Task-fixer succeeded. Running quality gates before merge..."

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
    cat > "$CURRENT_TASK" <<EOF
# Current Task
**Status:** idle
**Last failure:** $(date '+%Y-%m-%d %H:%M') -- [FIX ATTEMPT $new_attempts] $task_title ($_gate_label failed)
EOF
  else
    log "All quality gates passed. Merging $branch_name into $SKYNET_MAIN_BRANCH."
    cleanup_worktree  # Remove worktree, keep branch for merge
    cd "$PROJECT_DIR"
    git merge "$branch_name" --no-edit
    git branch -d "$branch_name"

    update_failed_line "$task_title" "| $(date '+%Y-%m-%d') | $task_title | merged to $SKYNET_MAIN_BRANCH | $error_summary | $((fix_attempts + 1)) | fixed |"
    fix_duration=$(format_duration $(( $(date +%s) - fix_start_epoch )))
    echo "| $(date '+%Y-%m-%d') | $task_title | merged to $SKYNET_MAIN_BRANCH | $fix_duration | fixed (attempt $((fix_attempts + 1))) |" >> "$COMPLETED"

    cat > "$CURRENT_TASK" <<EOF
# Current Task
**Status:** idle
**Last completed:** $(date '+%Y-%m-%d %H:%M') -- [FIXED] $task_title (merged to $SKYNET_MAIN_BRANCH)
EOF
    _CURRENT_TASK_TITLE=""
    log "Fixed and merged to $SKYNET_MAIN_BRANCH: $task_title"
    tg "✅ *$SKYNET_PROJECT_NAME_UPPER FIXED*: $task_title (attempt $((fix_attempts + 1)))"
  fi
else
  exit_code=$?
  log "Task-fixer failed again (exit $exit_code): $task_title"
  tg "❌ *$SKYNET_PROJECT_NAME_UPPER FIX FAILED*: $task_title (attempt $((fix_attempts + 1)))"

  cleanup_worktree  # Keep branch for next attempt
  new_attempts=$((fix_attempts + 1))
  update_failed_line "$task_title" "| $(date '+%Y-%m-%d') | $task_title | $branch_name | $error_summary (fix attempt $new_attempts failed) | $new_attempts | pending |"

  _CURRENT_TASK_TITLE=""
  cat > "$CURRENT_TASK" <<EOF
# Current Task
**Status:** idle
**Last failure:** $(date '+%Y-%m-%d %H:%M') -- [FIX ATTEMPT $new_attempts] $task_title
EOF
fi

log "Task-fixer finished."
