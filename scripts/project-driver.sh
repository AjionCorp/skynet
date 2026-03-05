#!/usr/bin/env bash
# project-driver.sh — Mission-driven strategic agent
# Reads mission.md + all .dev/ state files, then generates/prioritizes tasks that advance the mission
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_config.sh"
if [ -f "$SCRIPTS_DIR/mission-state.sh" ]; then
  source "$SCRIPTS_DIR/mission-state.sh"
else
  source "$PROJECT_DIR/scripts/mission-state.sh"
fi
_require_db

# --- Load mission (supports multi-mission via SKYNET_MISSION_SLUG env) ---
_mission_slug="${SKYNET_MISSION_SLUG:-}"
_mission_file="$MISSION"
_mission_hash=""
if [ -n "$_mission_slug" ] && [ -f "$MISSIONS_DIR/${_mission_slug}.md" ]; then
  _mission_file="$MISSIONS_DIR/${_mission_slug}.md"
  _mission_hash="$_mission_slug"
elif [ -f "$MISSION_CONFIG" ]; then
  # Fall back to active mission from _config.json
  _active=$(_resolve_active_mission)
  [ -f "$_active" ] && _mission_file="$_active"
fi

# Ensure mission hash is set when using active mission config (for task scoping).
if [ -z "$_mission_hash" ]; then
  _active_slug=$(_get_active_mission_slug)
  [ -n "$_active_slug" ] && _mission_hash="$_active_slug"
fi

_log_suffix="${_mission_hash:-global}"
LOG="$SCRIPTS_DIR/project-driver-${_log_suffix}.log"
BACKLOG_LOCK="${SKYNET_LOCK_PREFIX}-backlog.lock"

cd "$PROJECT_DIR"

# Per-script log — writes to project-driver-<mission>.log
# NOTE: Caller redirects stdout/stderr to $LOG, so we just echo here.
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

# --- Task normalization for deduplication ---
# Strip checkbox, strip tag prefix, lowercase, collapse whitespace, first 60 chars
_normalize_task_line() {
  echo "$1" \
    | sed 's/^- \[.\] //;s/^\[[^]]*\] //' \
    | tr '[:upper:]' '[:lower:]' \
    | sed 's/  */ /g;s/^ *//;s/ *$//' \
    | cut -c1-60
}

# NOTE: PID reuse between kill -0 check and lock reclaim is theoretically
# possible but practically negligible — the TOCTOU window is microseconds
# and Linux/macOS PID allocation is sequential up to pid_max (32768+ default).
# --- PID lock (per-mission) ---
LOCKFILE="${SKYNET_LOCK_PREFIX}-project-driver-${_log_suffix}.lock"
if mkdir "$LOCKFILE" 2>/dev/null; then
  if ! echo "$$" > "$LOCKFILE/pid" 2>/dev/null; then
    rmdir "$LOCKFILE" 2>/dev/null || true
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] PID write failed. Exiting." >> "$LOG"
    exit 1
  fi
else
  # Lock dir exists — check for stale lock (owner PID no longer running)
  if [ -d "$LOCKFILE" ] && [ -f "$LOCKFILE/pid" ]; then
    _existing_pid=$(cat "$LOCKFILE/pid" 2>/dev/null || echo "")
    if [ -n "$_existing_pid" ] && kill -0 "$_existing_pid" 2>/dev/null; then
      echo "[$(date '+%Y-%m-%d %H:%M:%S')] Already running (PID $_existing_pid). Exiting." >> "$LOG"
      exit 0
    fi
    # Stale lock — reclaim atomically
    mv "$LOCKFILE" "$LOCKFILE.stale.$$" 2>/dev/null || true
    rm -rf "$LOCKFILE.stale.$$" 2>/dev/null || true
    if mkdir "$LOCKFILE" 2>/dev/null; then
      if ! echo "$$" > "$LOCKFILE/pid" 2>/dev/null; then
        rmdir "$LOCKFILE" 2>/dev/null || true
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] PID write failed. Exiting." >> "$LOG"
        exit 1
      fi
    else
      echo "[$(date '+%Y-%m-%d %H:%M:%S')] Lock contention. Exiting." >> "$LOG"
      exit 0
    fi
  else
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Lock contention. Exiting." >> "$LOG"
    exit 0
  fi
fi
# NOTE: This overwrites any EXIT trap set by _config.sh. Currently _config.sh
# does not set EXIT traps, but if it does in the future, use trap chaining:
#   _pd_prev_trap="$(trap -p EXIT | sed "s/trap -- '//;s/' EXIT//")"
#   _pd_cleanup() { rm -rf "$LOCKFILE"; eval "$_pd_prev_trap"; }
#   trap '_pd_cleanup' EXIT
trap 'rm -rf "$LOCKFILE"' EXIT
trap 'log "Caught SIGTERM — shutting down"; exit 143' TERM
trap 'log "Caught SIGINT — shutting down"; exit 130' INT

# --- Pipeline pause check ---
if [ -f "$DEV_DIR/pipeline-paused" ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Pipeline paused — exiting" >> "$LOG"
  exit 0
fi

# --- Mission lifecycle state gate ---
# Check the mission's State: field. Only draft and active missions are workable.
# Paused, reviewing, complete, and failed missions skip the expensive agent cycle.
_mission_state=$(mission_get_state "$_mission_file")
case "$_mission_state" in
  complete)
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Mission state is 'complete' — idle mode. Exiting." >> "$LOG"
    exit 0
    ;;
  failed)
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Mission state is 'failed' — cannot proceed. Exiting." >> "$LOG"
    exit 0
    ;;
  paused)
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Mission state is 'paused' — skipping project-driver. Exiting." >> "$LOG"
    exit 0
    ;;
  reviewing)
    # "reviewing" is a transient checkpoint; if criteria are still unmet we must
    # resume generation instead of stalling forever.
    mission_set_state "$_mission_file" "$MISSION_STATE_ACTIVE" "project-driver"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Mission transitioned from reviewing → active (resuming generation)." >> "$LOG"
    _mission_state="$MISSION_STATE_ACTIVE"
    ;;
  draft)
    # Auto-transition draft → active when project-driver runs
    mission_set_state "$_mission_file" "$MISSION_STATE_ACTIVE" "project-driver"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Mission transitioned from draft → active." >> "$LOG"
    _mission_state="$MISSION_STATE_ACTIVE"
    ;;
esac

# Sentinel-based fallback (backward compat with watchdog)
_mission_id_safe_early=$(echo "${_mission_hash:-$(_get_active_mission_slug 2>/dev/null)}" | sed 's/[^a-zA-Z0-9]/_/g')
[ -z "$_mission_id_safe_early" ] && _mission_id_safe_early="global"
_mc_sentinel_early="$DEV_DIR/mission-complete-${_mission_id_safe_early}"
if [ -f "$_mc_sentinel_early" ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Mission-complete sentinel exists — idle mode. Exiting." >> "$LOG"
  exit 0
fi

# --- Claude Code auth pre-check (with alerting) ---
# Idempotent source — auth-check.sh has re-source guard
source "$SCRIPTS_DIR/auth-check.sh"
if ! check_any_auth; then
  log "No agent auth available (Claude/Codex). Skipping project-driver."
  exit 1
fi

log "Project driver starting${_mission_hash:+ (mission: $_mission_hash)}."
tg "🧠 *$SKYNET_PROJECT_NAME_UPPER PROJECT-DRIVER* starting — analyzing state and driving mission forward${_mission_hash:+ (mission: $_mission_hash)}"

if [ -f "$_mission_file" ]; then
  mission_content=$(cat "$_mission_file")
  log "Mission loaded from $_mission_file${_mission_hash:+ (hash: $_mission_hash)}"
else
  mission_content="${SKYNET_PROJECT_VISION:-No mission defined. Create .dev/mission.md to drive autonomous development.}"
  log "No mission file found. Using SKYNET_PROJECT_VISION fallback."
fi

# --- Gather all state (prefer SQLite, fallback to files on fresh projects) ---
# SQLite-based context (primary — structured, consistent)
if [ -n "$_mission_hash" ]; then
  _db_context=$(db_export_context_for_mission "$_mission_hash" 2>/dev/null || true)
else
  _db_context=$(db_export_context 2>/dev/null || true)
fi

# File-based fallback for data not yet in SQLite
if [ -f "$BACKLOG" ]; then
  _backlog_content=$(cat "$BACKLOG")
  backlog_unchecked_content=$(grep '^\- \[[ >]\]' "$BACKLOG" 2>/dev/null || true)
  backlog_recent_done_content=$(grep '^\- \[x\]' "$BACKLOG" 2>/dev/null | tail -40 || true)
  backlog_prompt_content="$backlog_unchecked_content"
  if [ -n "$backlog_recent_done_content" ]; then
    backlog_prompt_content="$backlog_prompt_content

# Recent checked history (last 40)
$backlog_recent_done_content"
  fi
else
  _backlog_content="(file not found)"
  backlog_prompt_content="(file not found)"
fi
if [ -f "$COMPLETED" ]; then completed_content=$(head -2 "$COMPLETED"; tail -30 "$COMPLETED"); else completed_content="(file not found)"; fi
if [ -f "$FAILED" ]; then failed_content=$(cat "$FAILED"); else failed_content="(file not found)"; fi
if [ -f "$CURRENT_TASK" ]; then current_task_content=$(cat "$CURRENT_TASK"); else current_task_content="(file not found)"; fi
if [ -f "$BLOCKERS" ]; then blockers_content=$(cat "$BLOCKERS"); else blockers_content="(file not found)"; fi
if [ -f "$SYNC_HEALTH" ]; then sync_health_content=$(cat "$SYNC_HEALTH"); else sync_health_content="(file not found)"; fi

# Count task metrics (prefer SQLite, fallback to file)
if [ -n "$_mission_hash" ]; then
  remaining=$(db_count_pending_for_mission "$_mission_hash" 2>/dev/null || echo 0)
else
  remaining=$(db_count_pending 2>/dev/null || grep -c '^\- \[ \]' "$BACKLOG" 2>/dev/null || echo 0)
fi
remaining=${remaining:-0}
case "$remaining" in ''|*[!0-9]*) remaining=0 ;; esac
if [ -n "$_mission_hash" ]; then
  claimed=$(db_count_claimed_for_mission "$_mission_hash" 2>/dev/null || echo 0)
else
  claimed=$(db_count_claimed 2>/dev/null || grep -c '^\- \[>\]' "$BACKLOG" 2>/dev/null || echo 0)
fi
claimed=${claimed:-0}
case "$claimed" in ''|*[!0-9]*) claimed=0 ;; esac
# shellcheck disable=SC2034
done_count=$(db_count_by_status "done" 2>/dev/null || grep -c '^\- \[x\]' "$BACKLOG" 2>/dev/null || echo 0)
done_count=${done_count:-0}
case "$done_count" in ''|*[!0-9]*) done_count=0 ;; esac
completed_count=$(db_count_by_status "completed" 2>/dev/null || echo "")
case "$completed_count" in ''|*[!0-9]*)
  completed_count=$(grep -c '^|' "$COMPLETED" 2>/dev/null || true)
  completed_count=${completed_count:-0}
  case "$completed_count" in ''|*[!0-9]*) completed_count=0 ;; esac
  completed_count=$((completed_count > 1 ? completed_count - 1 : 0))
  ;;
esac
failed_count=$(db_count_by_status "failed" 2>/dev/null || grep -c '| pending |' "$FAILED" 2>/dev/null || echo 0)
failed_count=${failed_count:-0}
case "$failed_count" in ''|*[!0-9]*) failed_count=0 ;; esac

# Get codebase structure summary (guard directories that may not exist yet)
if [ -d "$PROJECT_DIR" ]; then
  # Use -prune to skip node_modules entirely (avoids descending into them,
  # much faster than -not -path which still traverses the directory tree).
  api_routes=$(find "$PROJECT_DIR" -maxdepth 8 -name node_modules -prune -o -path "*/app/api/*/route.ts" -print 2>/dev/null | sort || true)
  pages=$(find "$PROJECT_DIR" -maxdepth 8 -name node_modules -prune -o -path "*/app/*/page.tsx" -print 2>/dev/null | sort || true)
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

# --- Pipeline velocity metrics (prefer SQLite, fallback to file) ---
_today=$(date '+%Y-%m-%d')
today_completed=$(_db "SELECT COUNT(*) FROM tasks WHERE status='completed' AND completed_at LIKE '${_today}%';" 2>/dev/null \
  || grep -c "$_today" "$COMPLETED" 2>/dev/null || echo 0)
today_completed=${today_completed:-0}
case "$today_completed" in ''|*[!0-9]*) today_completed=0 ;; esac
total_completed=$(db_count_by_status "completed" 2>/dev/null || echo "")
case "$total_completed" in ''|*[!0-9]*)
  total_completed=$(grep -c '^|' "$COMPLETED" 2>/dev/null || true)
  total_completed=${total_completed:-0}
  case "$total_completed" in ''|*[!0-9]*) total_completed=0 ;; esac
  total_completed=$((total_completed > 1 ? total_completed - 1 : 0))
  ;;
esac
total_failed=$(_db "SELECT COUNT(*) FROM tasks WHERE status IN ('failed','fixed','blocked','superseded') OR status LIKE 'fixing-%';" 2>/dev/null || echo "")
case "$total_failed" in ''|*[!0-9]*)
  total_failed=$(grep -c '^|' "$FAILED" 2>/dev/null || true)
  total_failed=${total_failed:-0}
  case "$total_failed" in ''|*[!0-9]*) total_failed=0 ;; esac
  total_failed=$((total_failed > 1 ? total_failed - 1 : 0))
  ;;
esac
fixed_count=$(db_count_by_status "fixed" 2>/dev/null || grep -c 'fixed' "$FAILED" 2>/dev/null || echo 0)
fixed_count=${fixed_count:-0}
case "$fixed_count" in ''|*[!0-9]*) fixed_count=0 ;; esac
fix_rate=$((fixed_count * 100 / (total_failed > 0 ? total_failed : 1)))

log "Velocity: today=$today_completed, total_completed=$total_completed, total_failed=$total_failed, fixed=$fixed_count, fix_rate=${fix_rate}%"

# --- Build the prompt ---
PROMPT="You are the Project Driver for ${SKYNET_PROJECT_NAME}. Your sole purpose is to drive this project toward its mission by generating, prioritizing, and managing the task backlog.

## THE MISSION

$mission_content

## CURRENT PIPELINE STATE

### Task Metrics
- Pending: $remaining | Claimed: $claimed | Completed: $completed_count | Failed (pending retry): $failed_count

### Backlog (.dev/backlog.md — unchecked + recent checked history)
$backlog_prompt_content

### Current Task (.dev/current-task.md)
$current_task_content

### Recent Completed Tasks (last 30 of $([ -f "$COMPLETED" ] && wc -l < "$COMPLETED" || echo 0) entries)
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
- If pending retry failures are high, prioritize failed-task deduplication/reconciliation before net-new feature work
- Keep one canonical task per root cause; supersede retries/variants instead of adding parallel duplicates
- If a root already has any active \`fixing-*\` row in \`.dev/failed-tasks.md\`, do not generate a parallel pending variant for that same root
- If pending retry failures exceed 20, bias generation toward reliability/security/reconciliation work and avoid net-new feature tasks unless they directly unblock the loop
- In hardening mode (all mission criteria met), default generation toward \`[FIX]\`, \`[INFRA]\`, \`[TEST]\`, and \`[DATA]\`; add \`[FEAT]\` only when it directly improves autonomous reliability or recovery throughput
- When generating shell test tasks, target \`tests/unit/\` paths; treat \`scripts/tests/*\` references as stale unless the repository actually contains those files
- Prefer one durable root-cause task title over repeated \"re-open\" variants; merge retries into the same canonical task description
- Treat backlog history rows marked with notes like \"typecheck failed\" as prior attempts, not as proof of closure; use canonical active roots in \`.dev/failed-tasks.md\` plus merged entries in \`.dev/completed.md\` for closure decisions
- Preserve any currently claimed \'[>]\' tasks exactly as-is at the top of backlog updates; do not rewrite or demote in-progress claims
- Keep at most 15 unchecked tasks total (\'[ ]\' + \'[>]\'); prioritize and trim lower-impact pending items when above limit
- Enforce canonical backlog ordering on every rewrite: all claimed \`[>]\` first, then pending \`[ ]\`, and checked history \`[x]\` only at the bottom
- Treat backlog section headers as non-authoritative formatting: compute ordering from task markers and regenerate the checked-history section after sorting so misplaced headers cannot keep \`[x]\` rows above active work

### 4. Self-Improvement Awareness
- If you notice the pipeline itself has gaps (missing scripts, broken flows, missing tests), generate tasks to fix them
- The pipeline improving itself IS part of the mission

### 5. Self-Prompt Evolution
- You are expected to modify your own prompt to best serve the mission
- Your prompt lives in \`scripts/project-driver.sh\` — the PROMPT variable starting at the line \`PROMPT=\"You are the Project Driver\`
- If you determine that your directives, context, or task format could be improved to produce better mission outcomes, edit the file directly
- Examples: add domain-specific heuristics you've learned, refine task generation rules, add new context sections, tune prioritization criteria
- Be surgical — preserve the shell variable interpolation (\$remaining, \$backlog_content, etc.) and the overall structure
- This is a superpower: you can make yourself smarter over time to better serve each project's unique mission

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
_dedup_snapshot=$(mktemp /tmp/skynet-dedup-snapshot-XXXXXX)
_dedup_normalized=$(mktemp /tmp/skynet-dedup-normalized-XXXXXX)
chmod 600 "$_dedup_snapshot" "$_dedup_normalized"
trap 'rm -rf "$LOCKFILE"; rm -f "$_dedup_snapshot" "$_dedup_normalized"' EXIT

# SQLite-based dedup snapshot (primary — covers all task states)
_db_all_titles=$(_db "SELECT title FROM tasks WHERE status NOT IN ('superseded');" 2>/dev/null || true)
if [ -n "$_db_all_titles" ]; then
  while IFS= read -r _t; do
    echo "- [ ] $_t" >> "$_dedup_snapshot"
    _normalize_task_line "- [ ] $_t" >> "$_dedup_normalized"
  done <<< "$_db_all_titles"
fi

# File-based fallback: also scan markdown files to catch anything not yet in SQLite
if [ -f "$BACKLOG" ]; then
  grep '^\- \[[ >x]\]' "$BACKLOG" >> "$_dedup_snapshot" 2>/dev/null || true
  while IFS= read -r _line; do
    _normalize_task_line "$_line"
  done < <(grep '^\- \[[ >x]\]' "$BACKLOG" 2>/dev/null || true) >> "$_dedup_normalized"
fi
if [ -f "$COMPLETED" ]; then
  _completed_tasks=$(awk -F'|' 'NR>2 {t=$3; gsub(/^ +| +$/,"",t); if(t!="") print "- [ ] " t}' "$COMPLETED")
  if [ -n "$_completed_tasks" ]; then
    echo "$_completed_tasks" >> "$_dedup_snapshot"
    while IFS= read -r _line; do
      _normalize_task_line "$_line"
    done <<< "$_completed_tasks" >> "$_dedup_normalized"
  fi
fi
if [ -f "$FAILED" ]; then
  _failed_active_tasks=$(awk -F'|' '
    function trim(v){ gsub(/^ +| +$/,"",v); return v }
    NR>2 {
      t=trim($3); s=trim($7)
      if (t != "" && (s == "pending" || s ~ /^fixing-/ || s == "blocked")) {
        print "- [ ] " t
      }
    }
  ' "$FAILED")
  if [ -n "$_failed_active_tasks" ]; then
    echo "$_failed_active_tasks" >> "$_dedup_snapshot"
    while IFS= read -r _line; do
      _normalize_task_line "$_line"
    done <<< "$_failed_active_tasks" >> "$_dedup_normalized"
  fi
fi
# Deduplicate the normalized file itself (SQLite + file may overlap)
sort -u "$_dedup_normalized" -o "$_dedup_normalized"

if run_agent "$PROMPT" "$LOG"; then
  # --- Deduplicate newly added tasks against pre-existing entries ---
  # Acquire backlog lock to prevent races with dev-worker claiming tasks
  if [ -f "$BACKLOG" ] && [ -s "$_dedup_normalized" ] && mkdir "$BACKLOG_LOCK" 2>/dev/null; then
    echo $$ > "$BACKLOG_LOCK/pid" 2>/dev/null || true
    _dedup_cleaned=$(mktemp /tmp/skynet-dedup-cleaned-XXXXXX)
    chmod 600 "$_dedup_cleaned"
    trap 'rm -rf "$LOCKFILE"; rm -f "$_dedup_snapshot" "$_dedup_normalized" "$_dedup_cleaned"' EXIT
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
    rmdir "$BACKLOG_LOCK" 2>/dev/null || rm -rf "$BACKLOG_LOCK" 2>/dev/null || true
  fi

  # --- Reconcile backlog.md back to SQLite ---
  # The agent writes backlog.md directly. Parse new pending task lines that
  # don't exist in SQLite yet and insert them, then regenerate backlog.md
  # from SQLite to ensure file and DB stay in sync.
  _reconciled=0
  if [ -f "$BACKLOG" ]; then
    while IFS= read -r _bline; do
      # Extract tag and title from "- [ ] [TAG] Title" or "- [ ] [TAG] Title — Desc"
      _btag=$(echo "$_bline" | sed -n 's/^- \[ \] \[\([^]]*\)\].*/\1/p')
      [ -z "$_btag" ] && continue
      _brest=$(echo "$_bline" | sed 's/^- \[ \] \[[^]]*\] *//')
      # Split on " — " to separate title from description
      _btitle=$(echo "$_brest" | sed 's/ — .*//')
      _bdesc=""
      case "$_brest" in
        *" — "*) _bdesc=$(echo "$_brest" | sed 's/^[^—]*— //') ;;
      esac
      # Skip if task already exists in SQLite
      if db_task_exists "[$_btag] $_btitle" 2>/dev/null; then
        continue
      fi
      if db_task_exists "$_btitle" 2>/dev/null; then
        continue
      fi
      # Insert into SQLite (bottom position — project-driver manages priority)
      if db_add_task "$_btitle" "$_btag" "$_bdesc" "bottom" "" "$_mission_hash" >/dev/null 2>&1; then
        log "Reconciled new task to SQLite: [$_btag] $_btitle"
        _reconciled=$((_reconciled + 1))
      fi
    done < <(grep '^\- \[ \] \[' "$BACKLOG" 2>/dev/null || true)
  fi
  if [ "$_reconciled" -gt 0 ]; then
    log "Reconciled $_reconciled new task(s) from backlog.md into SQLite"
  fi
  # Regenerate backlog.md from SQLite (single source of truth)
  db_export_state_files 2>/dev/null || log "WARNING: db_export_state_files failed after reconciliation"

  new_remaining=$(db_count_pending 2>/dev/null || grep -c '^\- \[ \]' "$BACKLOG" 2>/dev/null || echo 0)
  new_remaining=${new_remaining:-0}
  case "$new_remaining" in ''|*[!0-9]*) new_remaining=0 ;; esac
  log "Project driver completed successfully."
  tg "📋 *$SKYNET_PROJECT_NAME_UPPER BACKLOG* updated: $new_remaining tasks queued (was $remaining)"
else
  exit_code=$?
  if [ "$exit_code" -eq 125 ]; then
    log "Project driver exited with code 125 (all agents hit usage limits) — auto-pausing pipeline."
    tg "⏸ *$SKYNET_PROJECT_NAME_UPPER PROJECT-DRIVER*: All agents hit usage limits — auto-pausing pipeline"
    emit_event "pipeline_paused" "Usage limits exhausted (project-driver)"
    touch "$DEV_DIR/pipeline-paused"
  else
    log "Project driver exited with code $exit_code."
    tg "⚠️ *$SKYNET_PROJECT_NAME_UPPER*: Project driver failed (exit $exit_code)"
  fi
fi

# --- Mission completion detection (via mission-state.sh) ---
# Uses the state machine library for criteria evaluation and state transitions.
# Keeps sentinel file for backward compatibility with watchdog.
_mission_id_safe=$(echo "${_mission_hash:-global}" | sed 's/[^a-zA-Z0-9]/_/g')
MISSION_COMPLETE_SENTINEL="$DEV_DIR/mission-complete-${_mission_id_safe}"

if [ ! -f "$MISSION_COMPLETE_SENTINEL" ]; then
  # Re-read pending count (may have changed after run_agent)
  if [ -n "$_mission_hash" ]; then
    mc_pending=$(db_count_pending_for_mission "$_mission_hash" 2>/dev/null | grep -oE '[0-9]+' | head -1 || echo 0)
  else
    mc_pending=$(db_count_pending 2>/dev/null | grep -oE '[0-9]+' | head -1 || grep -c '^\- \[ \]' "$BACKLOG" 2>/dev/null || echo 0)
  fi
  mc_pending=${mc_pending:-0}

  # Evaluate criteria using the state machine library
  _next_state=$(mission_evaluate_criteria "$_mission_file" "$mc_pending")

  case "$_next_state" in
    complete)
      log "MISSION COMPLETE: All criteria met."
      mission_set_state "$_mission_file" "$MISSION_STATE_COMPLETE" "project-driver"

      _mission_name=$(grep '^# ' "$_mission_file" | head -1 | sed 's/^# //' || echo "${_mission_hash:-global}")

      # Parse criteria for notification details
      _mc_raw_criteria=$(sed -n '/^## Success Criteria/,/^## /p' "$_mission_file" \
        | grep '^[-*][[:space:]]*\[[ xX]\]' || true)
      mc_total_criteria=$(echo "$_mc_raw_criteria" | wc -l | grep -oE '[0-9]+' | head -1 || echo 0)

      emit_event "mission_complete" "Mission '$_mission_name' ($([ -z "$_mission_hash" ] && echo "global" || echo "$_mission_hash")) completed. All $mc_total_criteria criteria met."

      tg "🎉🏆 *$SKYNET_PROJECT_NAME_UPPER MISSION COMPLETE!*
Mission: *$_mission_name*
All $mc_total_criteria success criteria have been achieved. The pipeline has fulfilled this mission's objectives!"

      # Write celebration entry to blockers.md
      {
        echo ""
        echo "## 🎉 Mission Complete: $_mission_name — $(date '+%Y-%m-%d %H:%M')"
        echo ""
        echo "All success criteria for mission '$_mission_name' have been met."
        echo ""
        echo "$_mc_raw_criteria"
        echo ""
      } >> "$BLOCKERS"

      # Write completion summary immediately (don't wait for watchdog cycle)
      mission_write_completion_summary "$_mission_file" "${_mission_hash:-global}" "$DEV_DIR" 2>/dev/null || \
        log "WARNING: Failed to write completion summary (watchdog will retry)"

      # Sentinel for backward compat with watchdog
      echo "{\"completedAt\": \"$(date -u '+%Y-%m-%dT%H:%M:%SZ')\", \"mission\": \"$_mission_name\", \"slug\": \"${_mission_hash:-global}\", \"criteriaCount\": $mc_total_criteria}" > "$MISSION_COMPLETE_SENTINEL"
      log "Mission state set to 'complete'. Sentinel written to $MISSION_COMPLETE_SENTINEL"
      ;;
    reviewing)
      log "Zero pending tasks but not all criteria met — transitioning to 'reviewing'."
      mission_set_state "$_mission_file" "$MISSION_STATE_REVIEWING" "project-driver"
      ;;
    active)
      # Tasks still pending — no state change needed
      ;;
    "")
      log "No success criteria found in mission file. Skipping completion detection."
      ;;
  esac
fi

log "Project driver finished."
