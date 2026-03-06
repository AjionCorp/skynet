#!/usr/bin/env bash
# task-fixer.sh — Analyzes failed tasks, diagnoses root cause, attempts fixes
# Reads failed-tasks.md, picks the oldest pending failure, tries to resolve it
# Uses git worktrees for branch isolation (same as dev-worker.sh).
# Supports multiple instances: pass instance ID as arg (default: 1)
#   bash task-fixer.sh      → fixer 1
#   bash task-fixer.sh 2    → fixer 2
set -euo pipefail

FIXER_ID="${1:-1}"
case "$FIXER_ID" in
  ''|*[!0-9]*|0)
    echo "[F?] ERROR: Fixer ID must be a positive integer (got '$FIXER_ID')" >&2
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
  ''|*[!0-9]*) echo "[F${FIXER_ID}] WARNING: SKYNET_WORKER_MEM_LIMIT_KB not numeric, skipping ulimit" >&2 ;;
  *) [ "$_SKYNET_WORKER_MEM_LIMIT_KB" -ge 524288 ] && ulimit -v "$_SKYNET_WORKER_MEM_LIMIT_KB" 2>/dev/null || echo "[F${FIXER_ID}] WARNING: Memory limit ${_SKYNET_WORKER_MEM_LIMIT_KB}KB too low (<512MB) or ulimit failed" >&2 ;;
esac

# Instance-specific log: fixer 1 → task-fixer.log, fixer 2+ → task-fixer-N.log
if [ "$FIXER_ID" = "1" ]; then
  LOG="$LOG_DIR/task-fixer.log"
else
  LOG="$LOG_DIR/task-fixer-${FIXER_ID}.log"
fi
MAX_FIX_ATTEMPTS="$SKYNET_MAX_FIX_ATTEMPTS"
FIXER_COOLDOWN="$DEV_DIR/fixer-cooldown"
FIXER_COOLDOWN_STREAK_EPOCH="$DEV_DIR/fixer-cooldown-last-epoch"

# Instance-specific worktree (isolated from dev-workers and other fixers)
WORKTREE_DIR="${SKYNET_WORKTREE_BASE}/fixer-${FIXER_ID}"

cd "$PROJECT_DIR"

# Multi-mission: read fixer's assigned mission for LLM config override
_fixer_mission_slug=$(_get_worker_mission_slug "task-fixer-${FIXER_ID}")

# task-fixer logs to file AND stdout (tee behavior)
log() { _log "info" "F${FIXER_ID}" "$*" "$LOG"; _log "info" "F${FIXER_ID}" "$*"; }

# Fail fast when configured agent plugin scripts are missing.
if ! validate_agent_plugin_files "$SKYNET_AGENT_PLUGIN"; then
  log "Missing required agent plugin script(s) for SKYNET_AGENT_PLUGIN=$SKYNET_AGENT_PLUGIN. Exiting."
  emit_event "fixer_idle" "Fixer $FIXER_ID: missing agent plugin scripts"
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

# --- Worktree helpers (shared module) ---
# Task-fixer uses non-strict install (continue on failure) and deletes stale
# branches before creating worktrees from main.
# NOTE: _worktree.sh is already sourced by _config.sh; no need to re-source here.
# shellcheck disable=SC2034  # read by _worktree.sh functions at runtime
WORKTREE_INSTALL_STRICT=false
# shellcheck disable=SC2034
WORKTREE_DELETE_STALE_BRANCH=true

# --- PID lock (instance-specific: fixer 1 → -task-fixer.lock, fixer 2+ → -task-fixer-N.lock) ---
if [ "$FIXER_ID" = "1" ]; then
  LOCKFILE="${SKYNET_LOCK_PREFIX}-task-fixer.lock"
else
  LOCKFILE="${SKYNET_LOCK_PREFIX}-task-fixer-${FIXER_ID}.lock"
fi
if ! acquire_worker_lock "$LOCKFILE" "$LOG" "F${FIXER_ID}"; then
  emit_event "fixer_idle" "Fixer $FIXER_ID: lock contention"
  exit 0
fi
# Track current task for cleanup on unexpected exit
_CURRENT_TASK_TITLE=""
_db_task_id=""
TRACE_ID=""

cleanup_on_exit() {
  local exit_code=$?
  # Clean up any leaked _sql_exec/_sql_query temp files
  _db_cleanup_tmpfiles 2>/dev/null || true
  # Release merge lock if held
  release_merge_lock 2>/dev/null || true
  # Abort any in-progress git merge on the main branch
  cd "$PROJECT_DIR" 2>/dev/null || true
  if [ -f "$PROJECT_DIR/.git/MERGE_HEAD" ]; then
    git merge --abort 2>/dev/null || true
    log "Crash recovery: aborted in-progress merge"
  fi
  git rebase --abort 2>/dev/null || true
  git checkout "$SKYNET_MAIN_BRANCH" 2>/dev/null || true
  # Clean up worktree if it exists
  cleanup_worktree 2>/dev/null || true
  # Unclaim task if we were mid-fix (revert fixing-N back to pending).
  # Only unclaim tasks whose fixer_id matches this instance, preventing
  # a broad sweep from reclaiming tasks belonging to other fixers.
  if [ -n "$_CURRENT_TASK_TITLE" ] && [ -n "$_db_task_id" ] && [ "$_db_task_id" != "0" ]; then
    # Verify the task is still claimed by this fixer before unclaiming
    local _claimed_fixer
    _claimed_fixer=$(_db "SELECT fixer_id FROM tasks WHERE id=$(_sql_int "$_db_task_id") AND status='fixing-$FIXER_ID';" 2>/dev/null || echo "")
    if [ "$_claimed_fixer" = "$FIXER_ID" ]; then
      db_unclaim_failure "$_db_task_id" "$FIXER_ID" 2>/dev/null || log "WARNING: db_unclaim_failure failed — task may remain stuck in fixing state"
      db_export_state_files 2>/dev/null || true
      log "Crash recovery: unclaimed task: $_CURRENT_TASK_TITLE (fixer $FIXER_ID)"
    fi
  elif [ -n "$_CURRENT_TASK_TITLE" ]; then
    # _db_task_id is empty or 0 — crash occurred before claiming completed.
    # Cannot unclaim without a valid task ID; log a warning for diagnostics.
    log "WARNING: Crash recovery skipped db_unclaim — no valid task ID for: $_CURRENT_TASK_TITLE"
  fi
  # Ensure fixer status is idle on exit (normal or abnormal)
  db_set_worker_idle "$FIXER_ID" "Fixer session ended (exit handler)" 2>/dev/null || log "WARNING: db_set_worker_idle failed in cleanup — dashboard may show stale fixer status"
  emit_event "fixer_idle" "Fixer $FIXER_ID: exit handler (code $exit_code)" 2>/dev/null || true
  # Release PID lock
  rm -rf "$LOCKFILE"
  # Log crash event (only on abnormal exit)
  if [ "$exit_code" -ne 0 ]; then
    log "task-fixer crashed (exit $exit_code). Cleanup complete."
  fi
}
trap cleanup_on_exit EXIT
# NOTE: $LINENO in ERR trap may be relative to function/subshell scope, not the file.
trap 'log "ERR on line $LINENO: $BASH_COMMAND"; exit 1' ERR

# --- Graceful shutdown handling ---
# When SIGTERM/SIGINT is received (e.g. from `skynet stop`), set a flag so we
# can finish the current phase cleanly and exit at the next safe checkpoint.
# This prevents mid-merge kills from leaving branches in inconsistent state.
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
  emit_event "fixer_idle" "Fixer $FIXER_ID: pipeline paused"
  exit 0
fi

# --- Mission completion check ---
# If this fixer's assigned mission is complete, stop claiming failed tasks.
if [ -n "${_fixer_mission_slug:-}" ] && [ -f "$MISSIONS_DIR/${_fixer_mission_slug}.md" ]; then
  _fixer_mission_state=$(_get_mission_state "$MISSIONS_DIR/${_fixer_mission_slug}.md")
  if [ "$_fixer_mission_state" = "complete" ]; then
    log "Mission '${_fixer_mission_slug}' is complete — no fixes needed. Exiting."
    db_set_worker_idle "$FIXER_ID" "Mission '${_fixer_mission_slug}' complete" 2>/dev/null || true
    emit_event "fixer_idle" "Fixer $FIXER_ID: mission '${_fixer_mission_slug}' complete — reassignment needed" 2>/dev/null || true
    tg "🏁 *$SKYNET_PROJECT_NAME_UPPER TASK-FIXER F${FIXER_ID}*: Mission '${_fixer_mission_slug}' complete — fixer idle, awaiting reassignment"
    exit 0
  fi
fi

# --- Claude Code auth pre-check (with alerting) ---
# Idempotent source — auth-check.sh has re-source guard
source "$SCRIPTS_DIR/auth-check.sh"
if ! check_any_auth; then
  log "No agent auth available (Claude/Codex). Skipping task-fixer."
  emit_event "fixer_idle" "Fixer $FIXER_ID: no auth available"
  exit 1
fi

# --- Retry budget: check for consecutive failures before attempting a fix ---
# Guard against permanent cooldown loops by only applying cooldown when the
# newest observed failure in the streak is newer than the last cooled streak.
_consec_all_fail=false
_newest_fail_epoch=0
# Per-fixer history (not global): each fixer should evaluate its own streak.
_db_last5=$(_db_sep "SELECT epoch, result FROM fixer_stats WHERE fixer_id=$FIXER_ID ORDER BY epoch DESC LIMIT 5;" 2>/dev/null || true)
if [ -n "$_db_last5" ]; then
  _fail_count=0; _total_count=0
  while IFS=$'\x1f' read -r _epoch _result; do
    [ -z "$_result" ] && continue
    case "${_epoch:-}" in ''|*[!0-9]*) _epoch=0 ;; esac
    [ "$_newest_fail_epoch" -eq 0 ] && _newest_fail_epoch=$_epoch
    _total_count=$((_total_count + 1))
    [ "$_result" = "failure" ] && _fail_count=$((_fail_count + 1))
  done <<< "$_db_last5"
  [ "$_total_count" -ge 5 ] && [ "$_fail_count" -ge 5 ] && _consec_all_fail=true
fi
if $_consec_all_fail; then
  _last_cooled_epoch=0
  if [ -f "$FIXER_COOLDOWN_STREAK_EPOCH" ]; then
    _last_cooled_epoch=$(cat "$FIXER_COOLDOWN_STREAK_EPOCH" 2>/dev/null || echo 0)
    case "${_last_cooled_epoch:-}" in ''|*[!0-9]*) _last_cooled_epoch=0 ;; esac
  fi
  if [ "$_newest_fail_epoch" -gt "$_last_cooled_epoch" ]; then
    date +%s > "$FIXER_COOLDOWN"
    echo "$_newest_fail_epoch" > "$FIXER_COOLDOWN_STREAK_EPOCH"
    log "Fixer paused: 5 consecutive failures, cooling down 30min"
    emit_event "fixer_idle" "Fixer $FIXER_ID: cooldown after 5 consecutive failures"
    rm -rf "$LOCKFILE"
    exit 0
  fi
fi

# --- Pre-flight: atomically claim next pending failed task ---

_db_task_id=""
task_title=""
branch_name=""
error_summary=""
fix_attempts=0

# Try SQLite first for atomic claim
_db_failures=$(db_get_pending_failures 2>/dev/null || true)
if [ -n "$_db_failures" ]; then
  while IFS=$'\x1f' read -r _fid _ftitle _fbranch _ferror _fattempts _fstatus; do
    [ -z "$_fid" ] && continue
    if ! echo "$_fattempts" | grep -Eq '^[0-9]+$'; then _fattempts=0; fi
    if [ "$_fattempts" -ge "$MAX_FIX_ATTEMPTS" ] 2>/dev/null; then
      log "Task '$_ftitle' has reached max fix attempts ($MAX_FIX_ATTEMPTS). Marking as blocked."
      db_block_task "$_fid" 2>/dev/null || log "WARNING: db_block_task failed for task '$_ftitle' — task may remain in failed state"
      db_add_blocker "Task '$_ftitle' failed $MAX_FIX_ATTEMPTS times. Needs human review. Error: $_ferror" "$_ftitle" 2>/dev/null || log "WARNING: db_add_blocker failed — blocker may not be recorded"
      tg "🚫 *${SKYNET_PROJECT_NAME_UPPER} TASK-FIXER F${FIXER_ID}* task BLOCKED after $MAX_FIX_ATTEMPTS attempts — $_ftitle"
      emit_event "task_blocked" "Fixer $FIXER_ID: $_ftitle (max attempts)"
      continue
    fi
    if db_claim_failure "$_fid" "$FIXER_ID" 2>/dev/null; then
      _db_task_id="$_fid"
      task_title="$_ftitle"
      branch_name="$_fbranch"
      error_summary="$_ferror"
      fix_attempts="$_fattempts"
      break
    fi
  done <<< "$_db_failures"
fi

if [ -z "$_db_task_id" ]; then
  log "No pending failed tasks. Nothing to fix."
  emit_event "fixer_idle" "Fixer $FIXER_ID: no pending failures"
  exit 0
fi

# Defensive max-attempts guard. The claiming loop above already skips tasks
# at max attempts and blocks them, so this should never fire. Kept as a
# safety net in case db_get_pending_failures returns stale data.
if [ "$fix_attempts" -ge "$MAX_FIX_ATTEMPTS" ] 2>/dev/null; then
  log "Task '$task_title' has reached max fix attempts ($MAX_FIX_ATTEMPTS). Marking as blocked."
  [ -n "$_db_task_id" ] && { db_block_task "$_db_task_id" 2>/dev/null || log "WARNING: db_block_task failed — task may remain in failed state"; }
  [ -n "$_db_task_id" ] && { db_add_blocker "Task '$task_title' failed $MAX_FIX_ATTEMPTS times. Error: $error_summary" "$task_title" 2>/dev/null || log "WARNING: db_add_blocker failed — blocker may not be recorded"; }
  tg "🚫 *${SKYNET_PROJECT_NAME_UPPER} TASK-FIXER F${FIXER_ID}* task BLOCKED after $MAX_FIX_ATTEMPTS attempts — $task_title"
  emit_event "task_blocked" "Fixer $FIXER_ID: $task_title (max attempts)"
  log "Moved to blockers. Exiting."
  emit_event "fixer_idle" "Fixer $FIXER_ID: task blocked (max attempts)"
  exit 0
fi

_CURRENT_TASK_TITLE="$task_title"

# Generate trace ID for task lifecycle tracing
TRACE_ID=$(_generate_trace_id)
if [ -n "$_db_task_id" ]; then
  db_set_trace_id "$_db_task_id" "$TRACE_ID" 2>/dev/null || true
fi

log "TRACE=$TRACE_ID Claimed failed task $_db_task_id: $task_title"
log "Attempting to fix: $task_title (attempt $((fix_attempts + 1))/$MAX_FIX_ATTEMPTS)"
tg "🔧 *$SKYNET_PROJECT_NAME_UPPER TASK-FIXER F${FIXER_ID}* starting — fixing: $task_title (attempt $((fix_attempts + 1))/$MAX_FIX_ATTEMPTS)"

# Track fixer status in SQLite so dashboard/watchdog can see what we're doing
db_set_worker_status "$FIXER_ID" "fixer" "in_progress" "$_db_task_id" "$task_title" "$branch_name" 2>/dev/null || log "WARNING: db_set_worker_status failed for fixer $FIXER_ID — dashboard may show stale fixer status"
db_update_progress "$FIXER_ID" 2>/dev/null || log "WARNING: db_update_progress failed for fixer $FIXER_ID — watchdog may detect false hung fixer"

# Rotate log if it exceeds max size (prevents unbounded growth)
rotate_log_if_needed "$LOG"

fix_start_epoch=$(date +%s)

# --- Set up worktree for the failed branch ---
_handle_worktree_failure() {
  log "Failed to create worktree for $branch_name (${WORKTREE_LAST_ERROR:-unknown}). Returning task to pending."
  [ -n "$_db_task_id" ] && { db_update_failure "$_db_task_id" "$error_summary" "$fix_attempts" "failed" || log "WARNING: db_update_failure failed — task state may be inconsistent"; }
  _CURRENT_TASK_TITLE=""
  emit_event "fixer_idle" "Fixer $FIXER_ID: worktree failure (${WORKTREE_LAST_ERROR:-unknown})"
  exit 0
}

_make_fix_branch() {
  local _branch_base
  _branch_base="$(echo "$task_title" | sed 's/^\[.*\] //' | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | tr -cd 'a-z0-9-' | head -c 40)"
  if [ -z "$_branch_base" ] || ! echo "$_branch_base" | grep -qE '^[a-z0-9]'; then
    log "WARNING: Could not sanitize task title into valid branch name, using fallback: task-$_db_task_id"
    # use a fallback based on task ID
    _branch_base="task-$_db_task_id"
  fi
  branch_name="fix/$_branch_base"
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
    worker_log="$LOG_DIR/dev-worker-${_wid}.log"
    log "Matched failed task to worker $_wid via current-task-${_wid}.md"
    break
  fi
done

# Method 2: Search worker logs for the branch name (works after task-file reset)
if [ -z "$worker_log" ]; then
  for _wlog in "$LOG_DIR"/dev-worker-*.log; do
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
  worker_log=$(ls -t "$LOG_DIR"/dev-worker-*.log 2>/dev/null | head -1 || true)
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

# Load skills matching this task's tag.
# Avoid grep here because set -e + pipefail would crash the fixer when no [TAG] exists.
_fixer_task_type=""
case "$task_title" in
  \[*\]*)
    _fixer_task_type="${task_title#\[}"
    _fixer_task_type="${_fixer_task_type%%]*}"
    ;;
esac
SKILL_CONTENT="$(get_skills_for_tag "${_fixer_task_type:-}")"

# Build pipeline context (other workers' tasks, recent completions)
PIPELINE_CONTEXT="$(_build_pipeline_context "$FIXER_ID")"

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
${PIPELINE_CONTEXT}${SKILL_CONTENT:+
## Project Skills

$SKILL_CONTENT
}
${SKYNET_WORKER_CONVENTIONS:-}"

# --- Graceful shutdown checkpoint (before fix attempt) ---
if $SHUTDOWN_REQUESTED; then
  log "Shutdown requested before fix attempt — unclaiming and exiting cleanly"
  [ -n "$_db_task_id" ] && { db_unclaim_failure "$_db_task_id" "$FIXER_ID" 2>/dev/null || log "WARNING: db_unclaim_failure failed — task may remain stuck in fixing state"; }
  _CURRENT_TASK_TITLE=""
  cleanup_worktree "$branch_name"
  emit_event "fixer_idle" "Fixer $FIXER_ID: shutdown before fix attempt"
  exit 0
fi

emit_event "fix_started" "Fixer $FIXER_ID: $task_title"

# Per-mission LLM config: read provider/model override for this fixer's mission
_fixer_llm_provider=""
_fixer_llm_model=""
if [ -n "${_fixer_mission_slug:-}" ]; then
  _llm_info=$(_get_mission_llm_config "$_fixer_mission_slug")
  _fixer_llm_provider=$(echo "$_llm_info" | head -1)
  _fixer_llm_model=$(echo "$_llm_info" | sed -n '2p')
  if [ -n "$_fixer_llm_model" ]; then
    log "Mission LLM override: provider=${_fixer_llm_provider:-auto} model=$_fixer_llm_model"
  fi
fi

if (
  if [ -n "$_fixer_llm_model" ]; then
    case "${_fixer_llm_provider:-}" in
      claude) export SKYNET_CLAUDE_MODEL="$_fixer_llm_model" ;;
      codex)  export SKYNET_CODEX_MODEL="$_fixer_llm_model" ;;
      gemini) export SKYNET_GEMINI_MODEL="$_fixer_llm_model" ;;
    esac
  fi
  cd "$WORKTREE_DIR" && run_agent "$PROMPT" "$LOG"
); then
  if $SHUTDOWN_REQUESTED; then
    log "Shutdown requested after fix — unclaiming and exiting cleanly"
    cleanup_worktree
    db_unclaim_failure "$_db_task_id" "$FIXER_ID" 2>/dev/null || log "WARNING: db_unclaim_failure failed — task may remain stuck in fixing state"
    _CURRENT_TASK_TITLE=""
    emit_event "fixer_idle" "Fixer $FIXER_ID: shutdown after fix"
    exit 0
  fi
  # Update progress epoch after agent finishes — long runs may have staled it
  db_update_progress "$FIXER_ID" 2>/dev/null || true
  log "TRACE=$TRACE_ID Agent completed"
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
    eval "_gate_cmd=\${${_gate_var}:-}"
    if [ -z "$_gate_cmd" ]; then break; fi
    log "Running gate $_gate_idx: $_gate_cmd"
    if ! (cd "$WORKTREE_DIR" && eval "$_gate_cmd") >> "$LOG" 2>&1; then
      _gate_failed="$_gate_cmd"
      break
    fi
    log "Gate $_gate_idx passed."
    db_update_progress "$FIXER_ID" 2>/dev/null || true
    _gate_idx=$((_gate_idx + 1))
  done

  # --- Shell syntax gate: bash -n on changed .sh files ---
  if [ -z "$_gate_failed" ]; then
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
  fi

  if [ -n "$_gate_failed" ]; then
    _gate_label=$(echo "$_gate_failed" | awk '{print $NF}')
    log "GATE FAILED: $_gate_failed. Branch NOT merged."
    cleanup_worktree  # Keep branch for next attempt
    new_attempts=$((fix_attempts + 1))
    [ -n "$_db_task_id" ] && { db_update_failure "$_db_task_id" "$_gate_label failed after fix attempt $new_attempts" "$new_attempts" "failed" || log "WARNING: db_update_failure failed — task state may be inconsistent"; }
    _CURRENT_TASK_TITLE=""
    db_add_fixer_stat "failure" "$task_title" "$FIXER_ID" 2>/dev/null || true
  else
    # --- Graceful shutdown checkpoint (before merge) ---
    if $SHUTDOWN_REQUESTED; then
      log "Shutdown requested before merge — reverting claim and exiting cleanly"
      cleanup_worktree  # Keep branch for next attempt
      db_unclaim_failure "$_db_task_id" "$FIXER_ID" 2>/dev/null || log "WARNING: db_unclaim_failure failed — task may remain stuck in fixing state"
      _CURRENT_TASK_TITLE=""
      emit_event "fixer_idle" "Fixer $FIXER_ID: shutdown before merge"
      exit 0
    fi

    # --- Pre-lock rebase: reduce merge lock hold time ---
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

    log "TRACE=$TRACE_ID Gates passed"
    log "All quality gates passed. Merging $branch_name into $SKYNET_MAIN_BRANCH."

    # Define state commit hook for do_merge_to_main
    _fixer_state_commit() {
      _fix_new_attempts=$((fix_attempts + 1))
      fix_duration_secs=$(( $(date +%s) - fix_start_epoch ))
      _fix_duration=$(format_duration $fix_duration_secs)
      [ -n "$_db_task_id" ] && { db_fix_task "$_db_task_id" "merged to $SKYNET_MAIN_BRANCH" "$_fix_new_attempts" "$error_summary" || log "WARNING: db_fix_task failed — task may not be recorded as fixed"; }
      # Regenerate state files from SQLite (authoritative source)
      db_export_state_files 2>/dev/null || true

      # Commit pipeline status updates BEFORE smoke test so revert can undo both
      git add "$BACKLOG" "$COMPLETED" "$FAILED" "$BLOCKERS" 2>/dev/null || true
      git commit -m "chore: update pipeline status after fixing $task_title" --no-verify 2>/dev/null || true
      # Returns 0 unconditionally — state commit failures are non-fatal (the task
      # will be re-attempted). Logging captures the failure for debugging.
      return 0
    }
    _MERGE_STATE_COMMIT_FN="_fixer_state_commit"

    # Call shared merge function (guarded against mid-merge SIGTERM)
    _merge_rc=0
    _IN_MERGE=true
    do_merge_to_main "$branch_name" "$WORKTREE_DIR" "$LOG" "$_pre_lock_rebased" || _merge_rc=$?
    _IN_MERGE=false
    log "TRACE=$TRACE_ID Merge result: rc=$_merge_rc"

    new_attempts=$((fix_attempts + 1))

    case $_merge_rc in
      0)
        # Success — merged + pushed
        _CURRENT_TASK_TITLE=""
        log "TRACE=$TRACE_ID Task completed"
        log "Fixed and merged to $SKYNET_MAIN_BRANCH: $task_title"
        tg "✅ *$SKYNET_PROJECT_NAME_UPPER FIXED*: $task_title (attempt $new_attempts)"
        emit_event "fix_succeeded" "Fixer $FIXER_ID: $task_title"
        db_add_fixer_stat "success" "$task_title" "$FIXER_ID" 2>/dev/null || true
        db_set_worker_idle "$FIXER_ID" "Fixer session ended — fixed $task_title" 2>/dev/null || true
        ;;
      1)
        # Merge conflict
        log "MERGE FAILED for $branch_name after rebase recovery — keeping as failed."
        [ -n "$_db_task_id" ] && { db_update_failure "$_db_task_id" "merge conflict after fix attempt $new_attempts" "$new_attempts" "failed" || log "WARNING: db_update_failure failed — task state may be inconsistent"; }
        _CURRENT_TASK_TITLE=""
        tg "❌ *$SKYNET_PROJECT_NAME_UPPER FIX MERGE FAILED*: $task_title (attempt $new_attempts)"
        emit_event "fix_merge_failed" "Fixer $FIXER_ID: $task_title"
        db_add_fixer_stat "failure" "$task_title" "$FIXER_ID" 2>/dev/null || true
        ;;
      2)
        # Typecheck failed post-merge (already reverted + pushed)
        emit_event "fix_reverted" "Fixer $FIXER_ID: $task_title (typecheck failed post-merge)"
        tg "🔄 *${SKYNET_PROJECT_NAME_UPPER} FIXER REVERTED*: $task_title (typecheck failed post-merge)"
        [ -n "$_db_task_id" ] && { db_update_failure "$_db_task_id" "typecheck failed post-merge" "$new_attempts" "failed" || log "WARNING: db_update_failure failed — task state may be inconsistent"; }
        _CURRENT_TASK_TITLE=""
        db_add_fixer_stat "failure" "$task_title" "$FIXER_ID" 2>/dev/null || true
        ;;
      3)
        # Critical failure (revert failed, main may be broken)
        tg "🚨 *${SKYNET_PROJECT_NAME_UPPER}* CRITICAL: revert failed for $task_title — main may be broken"
        emit_event "revert_failed" "Fixer $FIXER_ID: $task_title — critical merge failure"
        exit 1
        ;;
      4)
        # Merge lock contention — do not increment attempts (infra issue, not fix failure)
        emit_event "merge_lock_contention" "Fixer $FIXER_ID: $task_title"
        cleanup_worktree
        [ -n "$_db_task_id" ] && { db_update_failure "$_db_task_id" "$error_summary" "$fix_attempts" "failed" || log "WARNING: db_update_failure failed — task state may be inconsistent"; }
        _CURRENT_TASK_TITLE=""
        emit_event "fixer_idle" "Fixer $FIXER_ID: merge lock contention"
        exit 0
        ;;
      5)
        # Pull failed
        [ -n "$_db_task_id" ] && { db_unclaim_failure "$_db_task_id" "$FIXER_ID" 2>/dev/null || log "WARNING: db_unclaim_failure failed — task may remain stuck in fixing state"; }
        _CURRENT_TASK_TITLE=""
        ;;
      6)
        # Push failed (reverted + pushed revert)
        tg "🔄 *${SKYNET_PROJECT_NAME_UPPER} FIXER REVERTED*: $task_title (push failed)"
        emit_event "fix_reverted" "Fixer $FIXER_ID: $task_title (push failed post-merge)"
        [ -n "$_db_task_id" ] && { db_update_failure "$_db_task_id" "push failed post-merge" "$new_attempts" "failed" || log "WARNING: db_update_failure failed — task state may be inconsistent"; }
        db_export_state_files 2>/dev/null || true
        _CURRENT_TASK_TITLE=""
        db_add_fixer_stat "failure" "$task_title" "$FIXER_ID" 2>/dev/null || true
        ;;
      7)
        # Smoke test failed (reverted + pushed)
        [ -n "$_db_task_id" ] && { db_update_failure "$_db_task_id" "smoke test failed after fix" "$new_attempts" "failed" || log "WARNING: db_update_failure failed — task state may be inconsistent"; }
        db_export_state_files 2>/dev/null || true
        _CURRENT_TASK_TITLE=""
        tg "🔄 *$SKYNET_PROJECT_NAME_UPPER FIXER REVERTED*: $task_title (smoke test failed)"
        emit_event "fix_reverted" "Fixer $FIXER_ID: $task_title (smoke test failed)"
        db_add_fixer_stat "failure" "$task_title" "$FIXER_ID" 2>/dev/null || true
        ;;
    esac
  fi
else
  exit_code=$?
  if [ "$exit_code" -eq 124 ]; then
    log "Agent timed out after ${SKYNET_AGENT_TIMEOUT_MINUTES}m"
    tg "⏰ *$SKYNET_PROJECT_NAME_UPPER TASK-FIXER F${FIXER_ID}*: Agent timed out after ${SKYNET_AGENT_TIMEOUT_MINUTES}m — $task_title"
  fi
  # SH-P3-1: Exit code 125 from run_agent means ALL available agents hit usage limits.
  # If code 125 is returned, we exit without recording an attempt or triggering cooldown.
  # If any other error (including partial limit hits that triggered fallback), we continue.
  if [ "$exit_code" -eq 125 ]; then
    log "All available agents hit usage limits (exit 125) — auto-pausing pipeline."
    tg "⏸ *$SKYNET_PROJECT_NAME_UPPER TASK-FIXER F${FIXER_ID}*: All agents hit usage limits — auto-pausing pipeline"
    emit_event "pipeline_paused" "Usage limits exhausted"
    touch "$DEV_DIR/pipeline-paused"
    cleanup_worktree  # Keep branch for next attempt
    # Unclaim the failure so another fixer can pick it up when unpaused
    [ -n "$_db_task_id" ] && { db_unclaim_failure "$_db_task_id" "$FIXER_ID" 2>/dev/null || log "WARNING: db_unclaim_failure failed"; }
    _CURRENT_TASK_TITLE=""
    emit_event "fixer_usage_limit" "Fixer $FIXER_ID: $task_title"
    emit_event "fixer_idle" "Fixer $FIXER_ID: all agents exhausted"
    log "Task-fixer finished."
    exit 0
  fi
  log "Task-fixer failed again (exit $exit_code): $task_title"
  tg "❌ *$SKYNET_PROJECT_NAME_UPPER FIX FAILED*: $task_title (attempt $((fix_attempts + 1)))"
  emit_event "fix_failed" "Fixer $FIXER_ID: $task_title"

  cleanup_worktree  # Keep branch for next attempt
  new_attempts=$((fix_attempts + 1))
  [ -n "$_db_task_id" ] && { db_update_failure "$_db_task_id" "$error_summary (fix attempt $new_attempts failed)" "$new_attempts" "failed" || log "WARNING: db_update_failure failed — task state may be inconsistent"; }

  _CURRENT_TASK_TITLE=""
  db_add_fixer_stat "failure" "$task_title" "$FIXER_ID" 2>/dev/null || true
fi

# Ensure fixer is idle before exit (cleanup_on_exit also does this as a safety net)
db_set_worker_idle "$FIXER_ID" "Fixer session ended" 2>/dev/null || log "WARNING: db_set_worker_idle failed for fixer $FIXER_ID — dashboard may show stale fixer status"
emit_event "fixer_idle" "Fixer $FIXER_ID: session ended"
log "Task-fixer finished."
