#!/usr/bin/env bash
# project-driver.sh — Mission-driven strategic agent
# Reads mission.md + all .dev/ state files, then generates/prioritizes tasks that advance the mission
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_config.sh"

LOG="$SCRIPTS_DIR/project-driver.log"

cd "$PROJECT_DIR"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

# --- Task normalization for deduplication ---
# Strip checkbox, strip tag prefix, lowercase, collapse whitespace, first 60 chars
_normalize_task_line() {
  echo "$1" \
    | sed 's/^- \[.\] //;s/^\[[^]]*\] //' \
    | tr '[:upper:]' '[:lower:]' \
    | sed 's/  */ /g;s/^ *//;s/ *$//' \
    | cut -c1-60
}

# --- PID lock ---
LOCKFILE="${SKYNET_LOCK_PREFIX}-project-driver.lock"
if [ -f "$LOCKFILE" ] && kill -0 "$(cat "$LOCKFILE")" 2>/dev/null; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Already running (PID $(cat "$LOCKFILE")). Exiting." >> "$LOG"
  exit 0
fi
echo $$ > "$LOCKFILE"
trap 'rm -f "$LOCKFILE"' EXIT

# --- Pipeline pause check ---
if [ -f "$DEV_DIR/pipeline-paused" ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Pipeline paused — exiting" >> "$LOG"
  exit 0
fi

# --- Claude Code auth pre-check (with alerting) ---
source "$SCRIPTS_DIR/auth-check.sh"
if ! check_claude_auth; then
  exit 1
fi

log "Project driver starting."
tg "🧠 *$SKYNET_PROJECT_NAME_UPPER PROJECT-DRIVER* starting — analyzing state and driving mission forward"

# --- Load mission ---
if [ -f "$MISSION" ]; then
  mission_content=$(cat "$MISSION")
  log "Mission loaded from $MISSION"
else
  mission_content="${SKYNET_PROJECT_VISION:-No mission defined. Create .dev/mission.md to drive autonomous development.}"
  log "No mission.md found. Using SKYNET_PROJECT_VISION fallback."
fi

# --- Gather all state (guard against missing files on fresh projects) ---
if [ -f "$BACKLOG" ]; then backlog_content=$(cat "$BACKLOG"); else backlog_content="(file not found)"; fi
if [ -f "$COMPLETED" ]; then completed_content=$(cat "$COMPLETED"); else completed_content="(file not found)"; fi
if [ -f "$FAILED" ]; then failed_content=$(cat "$FAILED"); else failed_content="(file not found)"; fi
if [ -f "$CURRENT_TASK" ]; then current_task_content=$(cat "$CURRENT_TASK"); else current_task_content="(file not found)"; fi
if [ -f "$BLOCKERS" ]; then blockers_content=$(cat "$BLOCKERS"); else blockers_content="(file not found)"; fi
if [ -f "$SYNC_HEALTH" ]; then sync_health_content=$(cat "$SYNC_HEALTH"); else sync_health_content="(file not found)"; fi

# Count task metrics
remaining=$(grep -c '^\- \[ \]' "$BACKLOG" 2>/dev/null || true)
remaining=${remaining:-0}
claimed=$(grep -c '^\- \[>\]' "$BACKLOG" 2>/dev/null || true)
claimed=${claimed:-0}
# shellcheck disable=SC2034
done_count=$(grep -c '^\- \[x\]' "$BACKLOG" 2>/dev/null || true)
done_count=${done_count:-0}
completed_count=$(grep -c '^|' "$COMPLETED" 2>/dev/null || true)
completed_count=${completed_count:-0}
completed_count=$((completed_count > 1 ? completed_count - 1 : 0))
failed_count=$(grep -c '| pending |' "$FAILED" 2>/dev/null || true)
failed_count=${failed_count:-0}

# Get codebase structure summary (guard directories that may not exist yet)
if [ -d "$PROJECT_DIR" ]; then
  api_routes=$(find "$PROJECT_DIR" -path "*/app/api/*/route.ts" -not -path "*/node_modules/*" 2>/dev/null | sort || true)
  pages=$(find "$PROJECT_DIR" -path "*/app/*/page.tsx" -not -path "*/node_modules/*" 2>/dev/null | sort || true)
else
  api_routes="(project directory not found)"
  pages="(project directory not found)"
fi
scripts_list=$(find "$SKYNET_SCRIPTS_DIR" -maxdepth 1 -name '*.sh' -exec basename {} \; 2>/dev/null || true)
if [ -d "$PROJECT_DIR/packages" ]; then
  packages_list=$(find "$PROJECT_DIR/packages" -maxdepth 2 -name "package.json" -exec dirname {} \; 2>/dev/null | while read -r d; do basename "$d"; done || true)
else
  packages_list="(no packages directory)"
fi

log "State: $remaining pending, $claimed claimed, $completed_count completed, $failed_count failed"

# --- Pipeline velocity metrics ---
today_completed=$(grep -c "$(date '+%Y-%m-%d')" "$COMPLETED" 2>/dev/null || true)
today_completed=${today_completed:-0}
total_completed=$(grep -c '^|' "$COMPLETED" 2>/dev/null || true)
total_completed=${total_completed:-0}
total_completed=$((total_completed > 1 ? total_completed - 1 : 0))
total_failed=$(grep -c '^|' "$FAILED" 2>/dev/null || true)
total_failed=${total_failed:-0}
total_failed=$((total_failed > 1 ? total_failed - 1 : 0))
fixed_count=$(grep -c 'fixed' "$FAILED" 2>/dev/null || true)
fixed_count=${fixed_count:-0}
fix_rate=$((fixed_count * 100 / (total_failed > 0 ? total_failed : 1)))

log "Velocity: today=$today_completed, total_completed=$total_completed, total_failed=$total_failed, fixed=$fixed_count, fix_rate=${fix_rate}%"

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

## Pipeline Velocity
- Tasks completed today: $today_completed
- Total tasks completed: $total_completed
- Total tasks failed: $total_failed
- Tasks fixed after failure: $fixed_count
- Fix rate: ${fix_rate}%

Use these metrics to calibrate task generation: if fix rate is low, prioritize simpler/smaller tasks; if velocity is high, consider more ambitious tasks.

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
Tags: \`[FEAT]\` features, \`[FIX]\` bugs, \`[INFRA]\` infrastructure, \`[TEST]\` tests, \`[DATA]\` data/sync, \`[DOCS]\` documentation, \`[NMI]\` need more information (incomplete/unverified tasks)

## Rules
- Write the updated backlog.md directly to $BACKLOG
- Checked items [x] stay at the bottom as history
- Top of list = highest priority
- Max 15 unchecked tasks (focus > sprawl)
- Every task must be actionable by Claude Code in one session
- If the mission is achieved (all success criteria met), write that to $BLOCKERS as a celebration, not a blocker"

# --- Snapshot existing backlog for post-agent deduplication ---
_dedup_snapshot=$(mktemp)
_dedup_normalized=$(mktemp)
trap 'rm -f "$LOCKFILE" "$_dedup_snapshot" "$_dedup_normalized"' EXIT
if [ -f "$BACKLOG" ]; then
  grep '^\- \[[ >]\]' "$BACKLOG" > "$_dedup_snapshot" 2>/dev/null || true
  while IFS= read -r _line; do
    _normalize_task_line "$_line"
  done < "$_dedup_snapshot" > "$_dedup_normalized"
fi

if run_agent "$PROMPT" "$LOG"; then
  # --- Deduplicate newly added tasks against pre-existing entries ---
  if [ -f "$BACKLOG" ] && [ -s "$_dedup_normalized" ]; then
    _dedup_cleaned=$(mktemp)
    _dedup_count=0
    while IFS= read -r _line; do
      if echo "$_line" | grep -q '^\- \[ \]'; then
        # Exact match with old backlog — not a new task, keep it
        if grep -qxF "$_line" "$_dedup_snapshot" 2>/dev/null; then
          echo "$_line" >> "$_dedup_cleaned"
          continue
        fi
        # New pending task — check normalized form against existing entries
        _norm=$(_normalize_task_line "$_line")
        if grep -qxF "$_norm" "$_dedup_normalized" 2>/dev/null; then
          _title=$(echo "$_line" | sed 's/^- \[ \] //')
          log "Skipped duplicate: $_title"
          _dedup_count=$((_dedup_count + 1))
          continue
        fi
      fi
      echo "$_line" >> "$_dedup_cleaned"
    done < "$BACKLOG"
    if [ "$_dedup_count" -gt 0 ]; then
      mv "$_dedup_cleaned" "$BACKLOG"
      log "Deduplication: removed $_dedup_count duplicate task(s)"
    else
      rm -f "$_dedup_cleaned"
    fi
  fi

  new_remaining=$(grep -c '^\- \[ \]' "$BACKLOG" 2>/dev/null || true)
  new_remaining=${new_remaining:-0}
  log "Project driver completed successfully."
  tg "📋 *$SKYNET_PROJECT_NAME_UPPER BACKLOG* updated: $new_remaining tasks queued (was $remaining)"
else
  exit_code=$?
  log "Project driver exited with code $exit_code."
  tg "⚠️ *$SKYNET_PROJECT_NAME_UPPER*: Project driver failed (exit $exit_code)"
fi

# --- Mission completion detection ---
# Check if all 6 success criteria are met and no pending tasks remain.
# Uses a sentinel file to prevent repeated notifications.
MISSION_COMPLETE_SENTINEL="$DEV_DIR/mission-complete"

if [ ! -f "$MISSION_COMPLETE_SENTINEL" ]; then
  # Re-read pending count (may have changed after run_agent)
  mc_pending=$(grep -c '^\- \[ \]' "$BACKLOG" 2>/dev/null || true)
  mc_pending=${mc_pending:-0}

  if [ "$mc_pending" -eq 0 ]; then
    log "Zero pending tasks — evaluating mission success criteria."

    mc_all_met=true

    # Criterion 1: Completed tasks > 50
    mc_completed=$(grep -c '^|' "$COMPLETED" 2>/dev/null || true)
    mc_completed=${mc_completed:-0}
    mc_completed=$((mc_completed > 1 ? mc_completed - 1 : 0))
    if [ "$mc_completed" -gt 50 ]; then
      log "  Criterion 1 (completed tasks >50): MET ($mc_completed)"
    else
      log "  Criterion 1 (completed tasks >50): NOT MET ($mc_completed)"
      mc_all_met=false
    fi

    # Criterion 2: Self-correction rate > 95%
    mc_fixed=$(grep -c '| fixed |' "$FAILED" 2>/dev/null || true)
    mc_fixed=${mc_fixed:-0}
    mc_blocked=$(grep -c '| blocked |' "$FAILED" 2>/dev/null || true)
    mc_blocked=${mc_blocked:-0}
    mc_superseded=$(grep -c '| superseded |' "$FAILED" 2>/dev/null || true)
    mc_superseded=${mc_superseded:-0}
    mc_total_attempted=$((mc_fixed + mc_blocked + mc_superseded))
    if [ "$mc_total_attempted" -gt 0 ]; then
      mc_fix_rate=$((mc_fixed * 100 / mc_total_attempted))
    else
      mc_fix_rate=0
    fi
    if [ "$mc_fix_rate" -gt 95 ]; then
      log "  Criterion 2 (self-correction >95%): MET (${mc_fix_rate}%)"
    else
      log "  Criterion 2 (self-correction >95%): NOT MET (${mc_fix_rate}%)"
      mc_all_met=false
    fi

    # Criterion 3: No zombie/deadlock evidence in watchdog logs
    mc_watchdog_log="$SCRIPTS_DIR/watchdog.log"
    mc_zombie_refs=0
    mc_deadlock_refs=0
    if [ -f "$mc_watchdog_log" ]; then
      mc_zombie_refs=$(grep -ci 'zombie' "$mc_watchdog_log" 2>/dev/null || true)
      mc_zombie_refs=${mc_zombie_refs:-0}
      mc_deadlock_refs=$(grep -ci 'deadlock' "$mc_watchdog_log" 2>/dev/null || true)
      mc_deadlock_refs=${mc_deadlock_refs:-0}
    fi
    mc_issue_refs=$((mc_zombie_refs + mc_deadlock_refs))
    if [ "$mc_issue_refs" -eq 0 ]; then
      log "  Criterion 3 (no zombie/deadlock): MET (0 references)"
    else
      log "  Criterion 3 (no zombie/deadlock): NOT MET ($mc_issue_refs references)"
      mc_all_met=false
    fi

    # Criterion 4: Dashboard handler count >= 10
    mc_handlers_dir="$PROJECT_DIR/packages/dashboard/src/handlers"
    mc_handler_count=0
    if [ -d "$mc_handlers_dir" ]; then
      mc_handler_count=$(find "$mc_handlers_dir" -maxdepth 1 -name '*.ts' \
        ! -name '*.test.*' ! -name 'index.ts' 2>/dev/null | wc -l | tr -d ' ')
    fi
    if [ "$mc_handler_count" -ge 10 ]; then
      log "  Criterion 4 (handler count >=10): MET ($mc_handler_count)"
    else
      log "  Criterion 4 (handler count >=10): NOT MET ($mc_handler_count)"
      mc_all_met=false
    fi

    # Criterion 5: Mission tracking exists (mission.md with Success Criteria section)
    if [ -f "$MISSION" ] && grep -q '## Success Criteria' "$MISSION" 2>/dev/null; then
      log "  Criterion 5 (mission tracking exists): MET"
    else
      log "  Criterion 5 (mission tracking exists): NOT MET"
      mc_all_met=false
    fi

    # Criterion 6: Agent plugins exist (>= 2 .sh files in scripts/agents/)
    mc_agents_dir="$SKYNET_SCRIPTS_DIR/agents"
    mc_agent_count=0
    if [ -d "$mc_agents_dir" ]; then
      mc_agent_count=$(find "$mc_agents_dir" -maxdepth 1 -name '*.sh' 2>/dev/null | wc -l | tr -d ' ')
    fi
    if [ "$mc_agent_count" -ge 2 ]; then
      log "  Criterion 6 (agent plugins exist): MET ($mc_agent_count plugins)"
    else
      log "  Criterion 6 (agent plugins exist): NOT MET ($mc_agent_count plugins)"
      mc_all_met=false
    fi

    # If ALL criteria met: celebrate!
    if $mc_all_met; then
      log "ALL 6 MISSION SUCCESS CRITERIA MET — mission complete!"

      # Emit structured event
      emit_event "mission_complete" "All 6 success criteria met. Completed: $mc_completed, Fix rate: ${mc_fix_rate}%, Handlers: $mc_handler_count, Agents: $mc_agent_count"

      # Notify all configured channels
      tg "🎉🏆 *$SKYNET_PROJECT_NAME_UPPER MISSION COMPLETE!* All 6 success criteria met. Completed: $mc_completed tasks, Self-correction: ${mc_fix_rate}%, Handlers: $mc_handler_count, Agent plugins: $mc_agent_count. The pipeline has achieved its mission!"

      # Write celebration entry to blockers.md
      {
        echo ""
        echo "## 🎉 Mission Complete — $(date '+%Y-%m-%d %H:%M')"
        echo ""
        echo "All 6 mission success criteria have been met:"
        echo "1. Completed tasks: $mc_completed (>50)"
        echo "2. Self-correction rate: ${mc_fix_rate}% (>95%)"
        echo "3. Zombie/deadlock references: $mc_issue_refs (0)"
        echo "4. Dashboard handlers: $mc_handler_count (>=10)"
        echo "5. Mission tracking: present in mission.md"
        echo "6. Agent plugins: $mc_agent_count (>=2)"
        echo ""
        echo "The Skynet pipeline has achieved autonomous self-improving development."
      } >> "$BLOCKERS"

      # Set sentinel to prevent repeated notifications
      echo "{\"completedAt\": \"$(date -u '+%Y-%m-%dT%H:%M:%SZ')\", \"completedTasks\": $mc_completed, \"fixRate\": $mc_fix_rate, \"handlerCount\": $mc_handler_count, \"agentPlugins\": $mc_agent_count}" > "$MISSION_COMPLETE_SENTINEL"
      log "Mission-complete sentinel written to $MISSION_COMPLETE_SENTINEL"
    else
      log "Mission not yet complete — some criteria not met."
    fi
  fi
fi

log "Project driver finished."
