#!/usr/bin/env bash
# project-driver.sh — Mission-driven strategic agent
# Reads mission.md + all .dev/ state files, then generates/prioritizes tasks that advance the mission
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_config.sh"

LOG="$SCRIPTS_DIR/project-driver.log"

cd "$PROJECT_DIR"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

# --- PID lock ---
LOCKFILE="${SKYNET_LOCK_PREFIX}-project-driver.lock"
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

log "Project driver starting."
tg "🧠 *${SKYNET_PROJECT_NAME^^} PROJECT-DRIVER* starting — analyzing state and driving mission forward"

# --- Load mission ---
if [ -f "$MISSION" ]; then
  mission_content=$(cat "$MISSION")
  log "Mission loaded from $MISSION"
else
  mission_content="${SKYNET_PROJECT_VISION:-No mission defined. Create .dev/mission.md to drive autonomous development.}"
  log "No mission.md found. Using SKYNET_PROJECT_VISION fallback."
fi

# --- Gather all state ---
backlog_content=$(cat "$BACKLOG")
completed_content=$(cat "$COMPLETED")
failed_content=$(cat "$FAILED")
current_task_content=$(cat "$CURRENT_TASK")
blockers_content=$(cat "$BLOCKERS")
sync_health_content=$(cat "$SYNC_HEALTH")

# Count task metrics
remaining=$(grep -c '^\- \[ \]' "$BACKLOG" 2>/dev/null || echo "0")
claimed=$(grep -c '^\- \[>\]' "$BACKLOG" 2>/dev/null || echo "0")
done_count=$(grep -c '^\- \[x\]' "$BACKLOG" 2>/dev/null || echo "0")
completed_count=$(grep -c '^|' "$COMPLETED" 2>/dev/null || echo "0")
completed_count=$((completed_count > 1 ? completed_count - 1 : 0))
failed_count=$(grep -c '| pending |' "$FAILED" 2>/dev/null || echo "0")

# Get codebase structure summary
api_routes=$(find "$PROJECT_DIR" -path "*/app/api/*/route.ts" -not -path "*/node_modules/*" 2>/dev/null | sort || true)
pages=$(find "$PROJECT_DIR" -path "*/app/*/page.tsx" -not -path "*/node_modules/*" 2>/dev/null | sort || true)
scripts_list=$(ls "$SKYNET_SCRIPTS_DIR"/*.sh 2>/dev/null | xargs -I{} basename {} || true)
packages_list=$(find "$PROJECT_DIR/packages" -maxdepth 2 -name "package.json" 2>/dev/null | xargs -I{} dirname {} | xargs -I{} basename {} || true)

log "State: $remaining pending, $claimed claimed, $completed_count completed, $failed_count failed"

# --- Build the prompt ---
PROMPT="You are the Project Driver for ${SKYNET_PROJECT_NAME}. Your sole purpose is to drive this project toward its mission by generating, prioritizing, and managing the task backlog.

## THE MISSION

$mission_content

## CURRENT PIPELINE STATE

### Task Metrics
- Pending: $remaining | Claimed: $claimed | Completed: $completed_count | Failed (pending retry): $failed_count

### Backlog (.dev/backlog.md)
$backlog_content

### Current Task (.dev/current-task.md)
$current_task_content

### Completed Tasks (.dev/completed.md)
$completed_content

### Failed Tasks (.dev/failed-tasks.md)
$failed_content

### Blockers (.dev/blockers.md)
$blockers_content

### Sync Health (.dev/sync-health.md)
$sync_health_content

## CODEBASE STRUCTURE

### Scripts
$scripts_list

### Packages
$packages_list

### API Routes
$api_routes

### Pages
$pages

## YOUR DIRECTIVES

You are the strategic brain of this pipeline. Every action you take must advance the mission.

### 1. Assess Mission Progress
- What has been accomplished toward each mission objective?
- What gaps remain between current state and mission completion?
- Are there blockers preventing mission progress?

### 2. Generate Mission-Aligned Tasks
- Every task MUST trace back to a specific mission objective or success criterion
- Tasks should be atomic — completable by an AI agent in a single session
- Be specific: include file paths, function names, expected behavior
- Prioritize tasks that unblock other tasks or accelerate the most mission-critical path

### 3. Manage the Backlog
- If fewer than 5 pending tasks remain, generate new ones from mission gaps
- Reprioritize based on: mission impact > unblocking others > ease of completion
- Clear resolved blockers from blockers.md
- Don't duplicate tasks already in backlog, completed, or failed

### 4. Self-Improvement Awareness
- If you notice the pipeline itself has gaps (missing scripts, broken flows, missing tests), generate tasks to fix them
- The pipeline improving itself IS part of the mission

## Task Format
\`\`\`
- [ ] [TAG] Task title — specific description of what to implement/fix
\`\`\`
Tags: \`[FEAT]\` features, \`[FIX]\` bugs, \`[INFRA]\` infrastructure, \`[TEST]\` tests, \`[DATA]\` data/sync, \`[DOCS]\` documentation

## Rules
- Write the updated backlog.md directly to $BACKLOG
- Checked items [x] stay at the bottom as history
- Top of list = highest priority
- Max 15 unchecked tasks (focus > sprawl)
- Every task must be actionable by Claude Code in one session
- If the mission is achieved (all success criteria met), write that to $BLOCKERS as a celebration, not a blocker"

if run_agent "$PROMPT" "$LOG"; then
  new_remaining=$(grep -c '^\- \[ \]' "$BACKLOG" 2>/dev/null || echo "0")
  log "Project driver completed successfully."
  tg "📋 *${SKYNET_PROJECT_NAME^^} BACKLOG* updated: $new_remaining tasks queued (was $remaining)"
else
  exit_code=$?
  log "Project driver exited with code $exit_code."
  tg "⚠️ *${SKYNET_PROJECT_NAME^^}*: Project driver failed (exit $exit_code)"
fi

log "Project driver finished."
