#!/usr/bin/env bash
# project-driver.sh — Strategic agent that digests project state and drives progress
# Reads all .dev/ status files + codebase, then updates backlog with new/reprioritized tasks
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
tg "🧠 *${SKYNET_PROJECT_NAME^^} PROJECT-DRIVER* starting — analyzing state and generating tasks"

# --- Gather all context ---
backlog_content=$(cat "$BACKLOG")
completed_content=$(cat "$COMPLETED")
failed_content=$(cat "$FAILED")
current_task_content=$(cat "$CURRENT_TASK")
blockers_content=$(cat "$BLOCKERS")
sync_health_content=$(cat "$SYNC_HEALTH")

# Count remaining vs completed tasks
remaining=$(grep -c '^\- \[ \]' "$BACKLOG" 2>/dev/null || echo "0")
completed_count=$(grep -c '^|' "$COMPLETED" 2>/dev/null || echo "0")
completed_count=$((completed_count > 1 ? completed_count - 1 : 0))
failed_count=$(grep -c '| pending |' "$FAILED" 2>/dev/null || echo "0")

# Get codebase structure summary
api_routes=$(find "$PROJECT_DIR" -path "*/app/api/*/route.ts" 2>/dev/null | sort || true)
sync_libs=$(find "$PROJECT_DIR" -path "*/lib/sync/*.ts" 2>/dev/null | sort || true)
pages=$(find "$PROJECT_DIR" -path "*/app/*/page.tsx" 2>/dev/null | sort || true)
db_tables=$(grep "create table" "$PROJECT_DIR"/supabase/migrations/*.sql 2>/dev/null | sed 's/.*create table //' | sed 's/ (.*//' | sort || true)

log "State: $remaining pending, $completed_count completed, $failed_count failed"

# --- Ask Claude to analyze and update backlog ---
PROMPT="You are the Project Driver for ${SKYNET_PROJECT_NAME} — driving the vision forward.

## THE MISSION

${SKYNET_PROJECT_VISION:-No project vision configured. Focus on completing existing backlog tasks.}

## CURRENT STATE

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

### Existing API Routes
$api_routes

### Existing Sync Libraries
$sync_libs

### Existing Pages
$pages

### Database Tables
$db_tables

## YOUR INSTRUCTIONS

1. **Analyze** what's been completed, what's in progress, what's blocked, what's failed
2. **Identify gaps** between current state and the full vision above
3. **Generate new tasks** if the backlog is getting thin (fewer than 5 unchecked items)
4. **Prioritize** tasks that move us toward the core mission
5. **Reprioritize** — if a blocker was resolved, move unblocked tasks up
6. **Clear resolved blockers** from blockers.md

## Task Format
- \`[FEAT]\` new features
- \`[FIX]\` bug fixes
- \`[DATA]\` data pipeline / sync / ingestion
- \`[SCORE]\` scoring and analysis
- \`[CIVIC]\` civic engagement features
- \`[MOBILE]\` mobile app features
- \`[INFRA]\` infrastructure/devops
- \`[TEST]\` tests

## Rules
- Write the updated backlog.md directly to $BACKLOG
- Keep checked items [x] at the bottom as history
- Top = highest priority
- Be specific and actionable — every task should be completable by Claude Code in one session
- Don't duplicate tasks already in the backlog or completed
- Max 15 unchecked tasks at a time (focus > sprawl)
- Balance between data infrastructure and user-facing features"

if run_agent "$PROMPT" "$LOG"; then
  new_remaining=$(grep -c '^\- \[ \]' "$BACKLOG" 2>/dev/null || echo "0")
  log "Project driver completed successfully."
  tg "📋 *${SKYNET_PROJECT_NAME^^} BACKLOG* updated: $new_remaining tasks queued"
else
  exit_code=$?
  log "Project driver exited with code $exit_code."
  tg "⚠️ *${SKYNET_PROJECT_NAME^^}*: Project driver failed (exit $exit_code)"
fi

log "Project driver finished."
