#!/usr/bin/env bash
# task-fixer.sh — Analyzes failed tasks, diagnoses root cause, attempts fixes
# Reads failed-tasks.md, picks the oldest pending failure, tries to resolve it
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_config.sh"

LOG="$SCRIPTS_DIR/task-fixer.log"
MAX_FIX_ATTEMPTS="$SKYNET_MAX_FIX_ATTEMPTS"

cd "$PROJECT_DIR"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

# --- Helper: force-switch to a branch, cleaning .dev/ changes ---
safe_checkout() {
  local target_branch="$1"
  git checkout -- "${DEV_DIR##*/}/" 2>/dev/null || true
  git clean -fd "${DEV_DIR##*/}/" test-results/ "${SKYNET_PLAYWRIGHT_DIR:+${SKYNET_PLAYWRIGHT_DIR}/test-results/}" 2>/dev/null || true
  git checkout "$target_branch" 2>/dev/null || true
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
trap "rm -f $LOCKFILE" EXIT

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

log "Attempting to fix: $task_title (attempt $((fix_attempts + 1))/$MAX_FIX_ATTEMPTS)"
tg "🔧 *${SKYNET_PROJECT_NAME^^} TASK-FIXER* starting — fixing: $task_title (attempt $((fix_attempts + 1))/$MAX_FIX_ATTEMPTS)"

# Lock current task
cat > "$CURRENT_TASK" <<EOF
# Current Task
## [FIX] $task_title
**Status:** in_progress
**Started:** $(date '+%Y-%m-%d %H:%M')
**Branch:** $branch_name
**Mode:** task-fixer (attempt $((fix_attempts + 1))/$MAX_FIX_ATTEMPTS)
EOF

# Checkout the failed branch if it exists, otherwise create fresh from main
safe_checkout "$SKYNET_MAIN_BRANCH"
if git show-ref --verify --quiet "refs/heads/$branch_name" 2>/dev/null; then
  git checkout "$branch_name"
  log "Checked out existing branch: $branch_name"
else
  branch_name="fix/$(echo "$task_title" | sed 's/^\[.*\] //' | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | tr -cd 'a-z0-9-' | head -c 40)"
  git checkout -b "$branch_name"
  log "Created new fix branch: $branch_name"
fi

# Get recent log context for the failure
recent_log=$(tail -100 "$SCRIPTS_DIR/dev-worker.log" 2>/dev/null | grep -A 50 "$task_title" | tail -50 || echo "No log context available")

PROMPT="You are the task-fixer agent for the ${SKYNET_PROJECT_NAME} project at $PROJECT_DIR.

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

unset CLAUDECODE 2>/dev/null || true
if $SKYNET_CLAUDE_BIN $SKYNET_CLAUDE_FLAGS "$PROMPT" >> "$LOG" 2>&1; then
  log "Task-fixer succeeded. Verifying typecheck before merge..."

  # Clean .dev/ before typecheck to avoid false failures
  git checkout -- "${DEV_DIR##*/}/" 2>/dev/null || true
  git clean -fd test-results/ "${SKYNET_PLAYWRIGHT_DIR:+${SKYNET_PLAYWRIGHT_DIR}/test-results/}" 2>/dev/null || true

  # Gate 1: Typecheck
  if ! $SKYNET_TYPECHECK_CMD >> "$LOG" 2>&1; then
    log "Typecheck still failing after fix. Branch NOT merged."
    safe_checkout "$SKYNET_MAIN_BRANCH"
    new_attempts=$((fix_attempts + 1))
    update_failed_line "$task_title" "| $(date '+%Y-%m-%d') | $task_title | $branch_name | typecheck failed after fix attempt $new_attempts | $new_attempts | pending |"
    cat > "$CURRENT_TASK" <<EOF
# Current Task
**Status:** idle
**Last failure:** $(date '+%Y-%m-%d %H:%M') -- [FIX ATTEMPT $new_attempts] $task_title (typecheck failed)
EOF
  else
    log "Typecheck passed."

    # Gate 2: Playwright (if dev server running)
    playwright_ok=true
    if curl -sf "$SKYNET_DEV_SERVER_URL" > /dev/null 2>&1; then
      log "Running Playwright smoke tests..."
      if ! (cd "$PROJECT_DIR/$SKYNET_PLAYWRIGHT_DIR" && npx playwright test --reporter=list >> "$LOG" 2>&1); then
        log "Playwright FAILED. Branch NOT merged."
        playwright_ok=false
      else
        log "Playwright tests passed."
      fi
      cd "$PROJECT_DIR"
    else
      log "Dev server not reachable. Skipping Playwright."
    fi

    if $playwright_ok; then
      log "All checks passed. Merging $branch_name into $SKYNET_MAIN_BRANCH."
      safe_checkout "$SKYNET_MAIN_BRANCH"
      git merge "$branch_name" --no-edit
      git branch -d "$branch_name"

      update_failed_line "$task_title" "| $(date '+%Y-%m-%d') | $task_title | merged to $SKYNET_MAIN_BRANCH | $error_summary | $((fix_attempts + 1)) | fixed |"
      echo "| $(date '+%Y-%m-%d') | $task_title | merged to $SKYNET_MAIN_BRANCH | fixed (attempt $((fix_attempts + 1))) |" >> "$COMPLETED"

      cat > "$CURRENT_TASK" <<EOF
# Current Task
**Status:** idle
**Last completed:** $(date '+%Y-%m-%d %H:%M') -- [FIXED] $task_title (merged to $SKYNET_MAIN_BRANCH)
EOF
      log "Fixed and merged to $SKYNET_MAIN_BRANCH: $task_title"
      tg "✅ *${SKYNET_PROJECT_NAME^^} FIXED*: $task_title (attempt $((fix_attempts + 1)))"
    else
      safe_checkout "$SKYNET_MAIN_BRANCH"
      new_attempts=$((fix_attempts + 1))
      update_failed_line "$task_title" "| $(date '+%Y-%m-%d') | $task_title | $branch_name | playwright failed after fix attempt $new_attempts | $new_attempts | pending |"
      cat > "$CURRENT_TASK" <<EOF
# Current Task
**Status:** idle
**Last failure:** $(date '+%Y-%m-%d %H:%M') -- [FIX ATTEMPT $new_attempts] $task_title (playwright failed)
EOF
    fi
  fi
else
  exit_code=$?
  log "Task-fixer failed again (exit $exit_code): $task_title"
  tg "❌ *${SKYNET_PROJECT_NAME^^} FIX FAILED*: $task_title (attempt $((fix_attempts + 1)))"

  # Increment attempt count
  new_attempts=$((fix_attempts + 1))
  update_failed_line "$task_title" "| $(date '+%Y-%m-%d') | $task_title | $branch_name | $error_summary (fix attempt $new_attempts failed) | $new_attempts | pending |"

  cat > "$CURRENT_TASK" <<EOF
# Current Task
**Status:** idle
**Last failure:** $(date '+%Y-%m-%d %H:%M') -- [FIX ATTEMPT $new_attempts] $task_title
EOF
fi

safe_checkout "$SKYNET_MAIN_BRANCH"
log "Task-fixer finished."
