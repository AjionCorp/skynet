#!/usr/bin/env bash
# dev-worker.sh — Pick next task from backlog, implement it via Claude Code
# Flow: branch -> implement -> typecheck -> playwright -> merge to main -> cleanup
# On failure: moves task to failed-tasks.md, then tries the NEXT task
# Supports multiple workers: pass worker ID as arg (default: 1)
#   bash dev-worker.sh      → worker 1
#   bash dev-worker.sh 2    → worker 2
set -euo pipefail

# Worker ID (1 or 2)
WORKER_ID="${1:-1}"

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_config.sh"

LOG="$SCRIPTS_DIR/dev-worker-${WORKER_ID}.log"
STALE_MINUTES="$SKYNET_STALE_MINUTES"
MAX_TASKS_PER_RUN="$SKYNET_MAX_TASKS_PER_RUN"

# Shared lock dir for atomic backlog access (mkdir is atomic on all Unix)
BACKLOG_LOCK="${SKYNET_LOCK_PREFIX}-backlog.lock"

# Per-worker task file (worker 1 → current-task-1.md, worker 2 → current-task-2.md)
WORKER_TASK_FILE="$DEV_DIR/current-task-${WORKER_ID}.md"

cd "$PROJECT_DIR"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [W${WORKER_ID}] $*" >> "$LOG"; }

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

# --- Helper: atomically claim the next unchecked task from backlog ---
# Uses mkdir lock to prevent two workers from grabbing the same task.
# Changes "- [ ]" to "- [>]" (claimed) so the other worker skips it.
# Outputs the claimed task line (original "- [ ] ..." form) or empty string.
claim_next_task() {
  if ! acquire_lock; then echo ""; return; fi
  local task
  task=$(grep -m1 '^\- \[ \]' "$BACKLOG" 2>/dev/null || true)
  if [ -n "$task" ]; then
    if ! awk -v target="$task" 'found == 0 && $0 == target {sub(/- \[ \]/, "- [>]"); found=1} {print}' \
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
    grep -Fxv "$line_to_remove" "$BACKLOG" > "$BACKLOG.tmp" || true
    mv "$BACKLOG.tmp" "$BACKLOG"
  fi
  release_lock
}

# --- Helper: mark a backlog item as checked (completed/failed) ---
# Matches both claimed [>] and unclaimed [ ] versions of the task title,
# because safe_checkout may revert the claim marker before we get here.
mark_in_backlog() {
  local old_line="$1"
  local new_line="$2"
  # Extract the task title (strip the leading "- [>] " or "- [ ] ")
  local title="${old_line#- \[>\] }"
  acquire_lock || return
  if [ -f "$BACKLOG" ]; then
    awk -v title="$title" -v new="$new_line" '{
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
    sed "s/^- \[>\] $(printf '%s' "$task_title" | sed 's/[&/\]/\\&/g')/- [ ] $task_title/" \
      "$BACKLOG" > "$BACKLOG.tmp"
    mv "$BACKLOG.tmp" "$BACKLOG"
  fi
  release_lock
}

# --- Helper: force-switch to a branch, cleaning dirty .dev/ and test files ---
# Preserves backlog.md (shared state between workers) and completed/failed logs.
safe_checkout() {
  local target_branch="$1"
  cp "$BACKLOG" "/tmp/${SKYNET_PROJECT_NAME}-backlog-save-w${WORKER_ID}.md" 2>/dev/null || true
  cp "$COMPLETED" "/tmp/${SKYNET_PROJECT_NAME}-completed-save-w${WORKER_ID}.md" 2>/dev/null || true
  cp "$FAILED" "/tmp/${SKYNET_PROJECT_NAME}-failed-save-w${WORKER_ID}.md" 2>/dev/null || true
  git checkout -- . 2>/dev/null || true
  git clean -fd . 2>/dev/null || true
  git checkout "$target_branch" 2>/dev/null || true
  # Verify checkout succeeded before restoring state
  local actual_branch
  actual_branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
  if [ "$actual_branch" != "$target_branch" ]; then
    log "WARNING: safe_checkout failed — wanted $target_branch, got $actual_branch"
    return 1
  fi
  # Restore pipeline state files
  cp "/tmp/${SKYNET_PROJECT_NAME}-backlog-save-w${WORKER_ID}.md" "$BACKLOG" 2>/dev/null || true
  cp "/tmp/${SKYNET_PROJECT_NAME}-completed-save-w${WORKER_ID}.md" "$COMPLETED" 2>/dev/null || true
  cp "/tmp/${SKYNET_PROJECT_NAME}-failed-save-w${WORKER_ID}.md" "$FAILED" 2>/dev/null || true
}

# --- PID lock to prevent duplicate runs (per worker ID) ---
LOCKFILE="${SKYNET_LOCK_PREFIX}-dev-worker-${WORKER_ID}.lock"
if [ -f "$LOCKFILE" ] && kill -0 "$(cat "$LOCKFILE")" 2>/dev/null; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [W${WORKER_ID}] Already running (PID $(cat "$LOCKFILE")). Exiting." >> "$LOG"
  exit 0
fi
echo $$ > "$LOCKFILE"
# Track current task for cleanup on unexpected exit
_CURRENT_TASK_TITLE=""
cleanup_on_exit() {
  # Unclaim task if we were in the middle of one
  if [ -n "$_CURRENT_TASK_TITLE" ]; then
    unclaim_task "$_CURRENT_TASK_TITLE" 2>/dev/null || true
    log "Unexpected exit — unclaimed task: $_CURRENT_TASK_TITLE"
  fi
  rm -f "$LOCKFILE"
}
trap cleanup_on_exit EXIT
trap 'log "ERR on line $LINENO"; exit 1' ERR

# --- Claude Code auth pre-check (with alerting) ---
source "$SCRIPTS_DIR/auth-check.sh"
if ! check_claude_auth; then
  exit 1
fi

# --- Ensure dev server is running with log capture ---
SERVER_LOG="$SCRIPTS_DIR/next-dev.log"
SERVER_PID_FILE="$SCRIPTS_DIR/next-dev.pid"
if curl -sf "$SKYNET_DEV_SERVER_URL" > /dev/null 2>&1; then
  # Dev server is up — ensure we're tracking its PID
  if [ ! -f "$SERVER_PID_FILE" ] || ! kill -0 "$(cat "$SERVER_PID_FILE" 2>/dev/null)" 2>/dev/null; then
    server_pid=$(pgrep -f "next-server" 2>/dev/null | head -1 || true)
    if [ -n "$server_pid" ]; then
      echo "$server_pid" > "$SERVER_PID_FILE"
      log "Dev server found (PID $server_pid), log at $SERVER_LOG"
    fi
  fi
else
  # Dev server not running — start it with log capture
  log "Dev server not running. Starting via start-dev.sh..."
  bash "$SCRIPTS_DIR/start-dev.sh" >> "$LOG" 2>&1 || true
  sleep 5
fi

remaining_count=$(grep -c '^\- \[ \]' "$BACKLOG" 2>/dev/null || echo "0")
tg "🚀 *${SKYNET_PROJECT_NAME^^} W${WORKER_ID}* starting — $remaining_count tasks in backlog"

# --- Pre-flight checks: detect stale in-progress task for this worker ---
if grep -q "in_progress" "$WORKER_TASK_FILE" 2>/dev/null; then
  last_modified=$(file_mtime "$WORKER_TASK_FILE")
  now=$(date +%s)
  age_minutes=$(( (now - last_modified) / 60 ))

  if [ "$age_minutes" -lt "$STALE_MINUTES" ]; then
    log "Task already in_progress (${age_minutes}m old). Exiting."
    exit 0
  else
    log "Stale lock detected (${age_minutes}m old). Moving to failed."
    task_title=$(grep "^##" "$WORKER_TASK_FILE" | head -1 | sed 's/^## //')
    echo "| $(date '+%Y-%m-%d') | $task_title | -- | Stale lock after ${age_minutes}m | 0 | pending |" >> "$FAILED"
    remove_from_backlog "- [ ] $task_title"
  fi
fi

# --- Task loop ---
tasks_attempted=0

while [ "$tasks_attempted" -lt "$MAX_TASKS_PER_RUN" ]; do
  tasks_attempted=$((tasks_attempted + 1))

  # Atomically claim next unchecked task
  next_task=$(claim_next_task)
  if [ -z "$next_task" ]; then
    log "Backlog empty. Kicking off project-driver to refill."
    cat > "$WORKER_TASK_FILE" <<EOF
# Current Task
**Status:** idle
**Updated:** $(date '+%Y-%m-%d %H:%M')
**Note:** Backlog empty — project-driver kicked off to replenish
EOF
    # Kick off project-driver if not already running
    if ! ([ -f "${SKYNET_LOCK_PREFIX}-project-driver.lock" ] && kill -0 "$(cat "${SKYNET_LOCK_PREFIX}-project-driver.lock")" 2>/dev/null); then
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
  task_type=$(echo "$task_title" | grep -o '^\[.*\]' | tr -d '[]')
  branch_name="${SKYNET_BRANCH_PREFIX}$(echo "$task_title" | sed 's/^\[.*\] //' | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | tr -cd 'a-z0-9-' | head -c 40)"

  log "Starting task ($tasks_attempted/$MAX_TASKS_PER_RUN): $task_title"
  log "Branch: $branch_name"
  tg "🔨 *${SKYNET_PROJECT_NAME^^} W${WORKER_ID}* starting: $task_title"

  # Write current task status for this worker
  cat > "$WORKER_TASK_FILE" <<EOF
# Current Task
## $task_title
**Status:** in_progress
**Started:** $(date '+%Y-%m-%d %H:%M')
**Branch:** $branch_name
**Worker:** $WORKER_ID
EOF

  # Create feature branch from main (force-clean working tree first)
  safe_checkout "$SKYNET_MAIN_BRANCH"
  if ! git checkout -b "$branch_name" 2>/dev/null; then
    # Branch already exists (from a prior failed attempt) — safe_checkout handles dirty files
    safe_checkout "$branch_name"
  fi
  # Verify we're actually on the right branch (checkout can silently fail)
  current_branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
  if [ "$current_branch" != "$branch_name" ]; then
    log "CHECKOUT FAILED: expected $branch_name, got $current_branch — unclaiming task."
    unclaim_task "$task_title"
    continue
  fi

  # --- Implementation via Claude Code ---
  PROMPT="You are working on the ${SKYNET_PROJECT_NAME} project at $PROJECT_DIR.

Your task: $task_title

${SKYNET_WORKER_CONTEXT:-}

Instructions:
1. Read the codebase to understand existing patterns (check CLAUDE.md, existing sync code, API routes)
2. Implement the task following existing conventions
3. Run '$SKYNET_TYPECHECK_CMD' to verify no type errors -- fix any that arise (up to 3 attempts)
4. After implementing, check the dev server log for runtime errors: cat $SCRIPTS_DIR/next-dev.log | tail -50
   - If you see 500 errors, missing table errors, or import failures related to YOUR changes, fix them before committing
   - Also test your new API routes with curl (e.g. curl -s ${SKYNET_DEV_SERVER_URL}/api/your/route | head -20)
5. Stage and commit your changes to the current branch with a descriptive commit message
6. Do NOT modify any files in ${DEV_DIR##*/}/ -- those are managed by the pipeline

Debugging tools available to you:
- Server log: cat $SCRIPTS_DIR/next-dev.log | tail -100 (shows Next.js runtime errors, 500s, missing tables)
- Test an API route: curl -s ${SKYNET_DEV_SERVER_URL}/api/... | head -20
- Check if dev server is running: curl -sf ${SKYNET_DEV_SERVER_URL}

If you encounter a blocker you cannot resolve (missing API keys, unclear requirements, etc.):
- Write it to $BLOCKERS with the date and task name
- Do NOT commit broken code

${SKYNET_WORKER_CONVENTIONS:-}"

  run_agent "$PROMPT" "$LOG" && exit_code=0 || exit_code=$?
  if [ "$exit_code" -ne 0 ]; then
    log "Claude Code FAILED (exit $exit_code): $task_title"
    tg "❌ *${SKYNET_PROJECT_NAME^^} W${WORKER_ID} FAILED*: $task_title (claude exit $exit_code)"
    safe_checkout "$SKYNET_MAIN_BRANCH"
    echo "| $(date '+%Y-%m-%d') | $task_title | $branch_name | claude exit code $exit_code | 0 | pending |" >> "$FAILED"
    # Mark claimed task as failed in backlog
    mark_in_backlog "- [>] $task_title" "- [x] $task_title _(claude failed)_"
    _CURRENT_TASK_TITLE=""
    cat > "$WORKER_TASK_FILE" <<EOF
# Current Task
**Status:** idle
**Last failure:** $(date '+%Y-%m-%d %H:%M') -- $task_title (claude failed)
EOF
    log "Moved to failed-tasks. Trying next..."
    continue
  fi

  log "Claude Code completed. Running checks before merge..."

  # --- Gate 1: Typecheck ---
  git checkout -- "${DEV_DIR##*/}/" 2>/dev/null || true
  git clean -fd test-results/ "${SKYNET_PLAYWRIGHT_DIR:+${SKYNET_PLAYWRIGHT_DIR}/test-results/}" 2>/dev/null || true

  if ! $SKYNET_TYPECHECK_CMD >> "$LOG" 2>&1; then
    log "TYPECHECK FAILED. Branch NOT merged."
    tg "❌ *${SKYNET_PROJECT_NAME^^} W${WORKER_ID} FAILED*: $task_title (typecheck failed)"
    safe_checkout "$SKYNET_MAIN_BRANCH"
    echo "| $(date '+%Y-%m-%d') | $task_title | $branch_name | typecheck failed | 0 | pending |" >> "$FAILED"
    mark_in_backlog "- [>] $task_title" "- [x] $task_title _(typecheck failed)_"
    _CURRENT_TASK_TITLE=""
    cat > "$WORKER_TASK_FILE" <<EOF
# Current Task
**Status:** idle
**Last failure:** $(date '+%Y-%m-%d %H:%M') -- $task_title (typecheck failed, branch kept)
EOF
    log "Moved to failed-tasks. Branch $branch_name kept for task-fixer."
    continue
  fi

  log "Typecheck passed."

  # --- Gate 2: Playwright smoke tests (if dev server is running) ---
  # Only run smoke test as the merge gate — full suite is run by ui-tester/feature-validator
  if curl -sf "$SKYNET_DEV_SERVER_URL" > /dev/null 2>&1; then
    # Pre-check: is the database reachable? If Supabase is down, skip Playwright
    # (API routes will all 500 with "schema cache" errors regardless of code quality)
    db_healthy=true
    api_check=$(curl -sf "${SKYNET_DEV_SERVER_URL}/api/gov/officials?page=1&pageSize=1" 2>/dev/null || echo '{"error":"unreachable"}')
    if echo "$api_check" | grep -qi "schema cache\|PGRST\|Could not query"; then
      db_healthy=false
      log "WARNING: Supabase DB is down (PGRST002). Skipping Playwright gate — not a code issue."
      tg "⚠️ *${SKYNET_PROJECT_NAME^^} W${WORKER_ID}*: Supabase DB down — skipping Playwright gate for $task_title"
    fi

    if $db_healthy; then
      log "Dev server reachable. Running Playwright smoke tests..."
      if ! (cd "$PROJECT_DIR/$SKYNET_PLAYWRIGHT_DIR" && npx playwright test "$SKYNET_SMOKE_TEST" --reporter=list >> "$LOG" 2>&1); then
        log "PLAYWRIGHT FAILED. Branch NOT merged."
        tg "❌ *${SKYNET_PROJECT_NAME^^} W${WORKER_ID} FAILED*: $task_title (playwright failed)"
        cd "$PROJECT_DIR"
        safe_checkout "$SKYNET_MAIN_BRANCH"
        echo "| $(date '+%Y-%m-%d') | $task_title | $branch_name | playwright tests failed | 0 | pending |" >> "$FAILED"
        mark_in_backlog "- [>] $task_title" "- [x] $task_title _(playwright failed)_"
        _CURRENT_TASK_TITLE=""
        cat > "$WORKER_TASK_FILE" <<EOF
# Current Task
**Status:** idle
**Last failure:** $(date '+%Y-%m-%d %H:%M') -- $task_title (playwright failed, branch kept)
EOF
        log "Moved to failed-tasks. Branch $branch_name kept for task-fixer."
        continue
      fi
      log "Playwright tests passed."
    fi
  else
    log "Dev server not reachable. Skipping Playwright tests."
  fi

  # --- Gate 3: Check server logs for runtime errors ---
  if [ -f "$SCRIPTS_DIR/next-dev.log" ]; then
    log "Checking server logs for runtime errors..."
    bash "$SCRIPTS_DIR/check-server-errors.sh" >> "$LOG" 2>&1 || \
      log "Server errors found -- written to blockers.md (non-blocking for merge)"
  fi

  # --- All gates passed -- merge to main ---
  log "All checks passed. Merging $branch_name into $SKYNET_MAIN_BRANCH."

  safe_checkout "$SKYNET_MAIN_BRANCH"
  if ! git merge "$branch_name" --no-edit 2>>"$LOG"; then
    log "MERGE FAILED for $branch_name — aborting and moving to failed."
    git merge --abort 2>/dev/null || true
    echo "| $(date '+%Y-%m-%d') | $task_title | $branch_name | merge conflict | 0 | pending |" >> "$FAILED"
    mark_in_backlog "- [>] $task_title" "- [x] $task_title _(merge failed)_"
    _CURRENT_TASK_TITLE=""
    tg "❌ *${SKYNET_PROJECT_NAME^^} W${WORKER_ID}*: merge failed for $task_title"
    safe_checkout "$SKYNET_MAIN_BRANCH"
    continue
  fi
  git branch -d "$branch_name" 2>/dev/null || true

  mark_in_backlog "- [>] $task_title" "- [x] $task_title"
  _CURRENT_TASK_TITLE=""
  echo "| $(date '+%Y-%m-%d') | $task_title | merged to $SKYNET_MAIN_BRANCH | success |" >> "$COMPLETED"

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

  # Commit pipeline status updates so safe_checkout won't revert them
  git add "$BACKLOG" "$WORKER_TASK_FILE" "$COMPLETED" "$FAILED" 2>/dev/null || true
  git commit -m "chore: update pipeline status after $task_title" --no-verify 2>/dev/null || true

  log "Task completed and merged to $SKYNET_MAIN_BRANCH: $task_title"
  remaining=$(grep -c '^\- \[ \]' "$BACKLOG" 2>/dev/null || echo "0")
  tg "✅ *${SKYNET_PROJECT_NAME^^} W${WORKER_ID} MERGED*: $task_title ($remaining tasks remaining)"

  # Ensure we're on main for next iteration
  safe_checkout "$SKYNET_MAIN_BRANCH"
done

log "Dev worker $WORKER_ID finished. Attempted $tasks_attempted task(s)."
