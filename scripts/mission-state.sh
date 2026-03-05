#!/usr/bin/env bash
# mission-state.sh — Mission state machine function library
# Provides state constants, transition validation, and state read/write helpers.
# Sourced by project-driver.sh and watchdog.sh. Requires _config.sh to be loaded first.
#
# Mission states track the lifecycle of a mission from creation to completion.
# State is persisted as a "## State: <state>" heading in the mission .md file.
#
# Bash 3.2 compatible — no associative arrays, no ${VAR^^}.

# ============================================================
# MISSION STATES
# ============================================================
#
# Valid states:
#   draft      — Mission created but not yet activated
#   active     — Workers are executing tasks toward this mission
#   paused     — Temporarily halted (manual or automated)
#   reviewing  — All tasks done, evaluating success criteria
#   complete   — All success criteria met (terminal)
#   failed     — Mission abandoned or cannot proceed (terminal)
#
# Valid transitions:
#   draft      → active, failed
#   active     → paused, reviewing, complete, failed
#   paused     → active, failed
#   reviewing  → active, complete, failed
#   complete   → (terminal)
#   failed     → draft (re-plan)

# State constants (plain strings — no associative arrays for bash 3.2)
MISSION_STATE_DRAFT="draft"
MISSION_STATE_ACTIVE="active"
MISSION_STATE_PAUSED="paused"
MISSION_STATE_REVIEWING="reviewing"
MISSION_STATE_COMPLETE="complete"
MISSION_STATE_FAILED="failed"

# ============================================================
# TRANSITION VALIDATION
# ============================================================

# Validate a mission state transition. Audit-only: logs WARNING on unexpected
# transitions but does NOT block the operation. Non-breaking by design.
# Usage: mission_validate_transition "mission_slug" "from_state" "to_state" ["caller"]
mission_validate_transition() {
  local mission_id="$1"
  local from_state="$2"
  local to_state="$3"
  local caller="${4:-unknown}"

  # Empty from_state means we couldn't determine it — skip validation
  [ -z "$from_state" ] && return 0

  # Same-state transition is a no-op, always valid
  [ "$from_state" = "$to_state" ] && return 0

  local valid=false

  case "$from_state" in
    draft)
      case "$to_state" in
        active|failed) valid=true ;;
      esac
      ;;
    active)
      case "$to_state" in
        paused|reviewing|complete|failed) valid=true ;;
      esac
      ;;
    paused)
      case "$to_state" in
        active|failed) valid=true ;;
      esac
      ;;
    reviewing)
      case "$to_state" in
        active|complete|failed) valid=true ;;
      esac
      ;;
    complete|failed)
      # Terminal states — only failed can go back to draft (re-plan)
      case "$from_state" in
        failed)
          case "$to_state" in
            draft) valid=true ;;
          esac
          ;;
      esac
      ;;
  esac

  if ! $valid; then
    # Use log() if available, fall back to stderr
    if declare -f log >/dev/null 2>&1; then
      log "WARNING: Unexpected mission state transition for '$mission_id': '$from_state' → '$to_state' (caller: $caller)"
    else
      echo "[$(date '+%Y-%m-%d %H:%M:%S')] WARNING: Unexpected mission state transition for '$mission_id': '$from_state' → '$to_state' (caller: $caller)" >&2
    fi
  fi

  return 0
}

# Check if a state is terminal (no valid outbound transitions except failed→draft).
# Usage: mission_is_terminal "state" && echo "done"
mission_is_terminal() {
  local state="$1"
  case "$state" in
    complete) return 0 ;;
    *) return 1 ;;
  esac
}

# Check if a state value is a recognized mission state.
# Usage: mission_is_valid_state "active" && echo "ok"
mission_is_valid_state() {
  local state="$1"
  case "$state" in
    draft|active|paused|reviewing|complete|failed) return 0 ;;
    *) return 1 ;;
  esac
}

# ============================================================
# STATE READ/WRITE (mission .md files)
# ============================================================

# Read current state from a mission file. Returns the state string, or empty
# if no State: line found. Defaults to "draft" if the file exists but has no state.
# Usage: state=$(mission_get_state "/path/to/mission.md")
mission_get_state() {
  local mission_file="$1"
  [ -f "$mission_file" ] || return 0

  local state
  # Match both "## State: value" (canonical) and legacy "State: value" formats
  state=$(grep -iE '^(## )?State:' "$mission_file" 2>/dev/null | head -1 \
    | sed 's/^## //' | sed 's/^[Ss]tate:[[:space:]]*//' | sed 's/[[:space:]]*$//' \
    | tr '[:upper:]' '[:lower:]')

  if [ -z "$state" ]; then
    # File exists but no state line — treat as draft
    echo "$MISSION_STATE_DRAFT"
    return 0
  fi

  # Validate the state value
  if mission_is_valid_state "$state"; then
    echo "$state"
  else
    # Unknown state — log warning and return as-is so callers can handle it
    if declare -f log >/dev/null 2>&1; then
      log "WARNING: Unknown mission state '$state' in $mission_file"
    else
      echo "[$(date '+%Y-%m-%d %H:%M:%S')] WARNING: Unknown mission state '$state' in $mission_file" >&2
    fi
    echo "$state"
  fi
}

# Write state to a mission file. Inserts or updates the "State: <state>" line
# after the title (first # heading). Validates the transition before writing.
# Usage: mission_set_state "/path/to/mission.md" "active" ["caller"]
mission_set_state() {
  local mission_file="$1"
  local new_state="$2"
  local caller="${3:-unknown}"

  [ -f "$mission_file" ] || {
    if declare -f log >/dev/null 2>&1; then
      log "ERROR: Mission file not found: $mission_file"
    else
      echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: Mission file not found: $mission_file" >&2
    fi
    return 1
  }

  # Read current state for transition validation
  local current_state
  current_state=$(mission_get_state "$mission_file")

  # Validate the transition (audit-only, non-blocking)
  local slug
  slug=$(basename "$mission_file" .md)
  mission_validate_transition "$slug" "$current_state" "$new_state" "$caller"

  # Update or insert the ## State: line
  if grep -qiE '^(## )?State:' "$mission_file" 2>/dev/null; then
    # Replace existing State: line (supports both ## State: and legacy State: formats)
    sed -i.bak "s/^## [Ss]tate:.*$/## State: $new_state/" "$mission_file"
    # Also handle legacy format without ##
    sed -i.bak "s/^[Ss]tate:.*$/## State: $new_state/" "$mission_file"
    rm -f "${mission_file}.bak"
  else
    # Insert ## State: line after the first heading (# Title)
    # If no heading found, prepend to file
    if grep -q '^# ' "$mission_file" 2>/dev/null; then
      # Insert after first heading line
      local tmp="${mission_file}.tmp.$$"
      local inserted=false
      while IFS= read -r line || [ -n "$line" ]; do
        printf '%s\n' "$line"
        if ! $inserted && echo "$line" | grep -q '^# '; then
          printf '## State: %s\n' "$new_state"
          inserted=true
        fi
      done < "$mission_file" > "$tmp"
      mv "$tmp" "$mission_file"
    else
      # No heading — prepend state line
      local tmp="${mission_file}.tmp.$$"
      printf '## State: %s\n' "$new_state" > "$tmp"
      cat "$mission_file" >> "$tmp"
      mv "$tmp" "$mission_file"
    fi
  fi

  # Emit event if emit_event is available
  if declare -f emit_event >/dev/null 2>&1; then
    emit_event "mission_state_change" "Mission '$slug' state: $current_state → $new_state (caller: $caller)"
  fi
}

# ============================================================
# CONVENIENCE HELPERS
# ============================================================

# Get the state of the active mission. Returns state string or empty.
# Usage: state=$(mission_get_active_state)
mission_get_active_state() {
  local mission_file
  if declare -f _resolve_active_mission >/dev/null 2>&1; then
    mission_file=$(_resolve_active_mission)
  else
    mission_file="${MISSION:-}"
  fi
  [ -n "$mission_file" ] && [ -f "$mission_file" ] || return 0
  mission_get_state "$mission_file"
}

# Check if the active mission is in a workable state (draft or active).
# Returns 0 (true) if workers should be dispatched, 1 otherwise.
# Usage: mission_is_workable && dispatch_workers
mission_is_workable() {
  local state
  state=$(mission_get_active_state)
  case "${state:-draft}" in
    active|draft) return 0 ;;
    *) return 1 ;;
  esac
}

# Evaluate mission criteria and return the appropriate next state.
# Reads success criteria checkboxes from the mission file.
# Returns: "complete" if all met, "reviewing" if zero pending tasks but not all met,
# "active" if tasks still pending, or empty if no criteria found.
# Usage: next_state=$(mission_evaluate_criteria "/path/to/mission.md" pending_count)
mission_evaluate_criteria() {
  local mission_file="$1"
  local pending_count="${2:-0}"

  [ -f "$mission_file" ] || return 0

  # Parse Success Criteria section
  local raw_criteria
  raw_criteria=$(sed -n '/^## Success Criteria/,/^## /p' "$mission_file" \
    | grep '^[-*][[:space:]]*\[[ xX]\]' || true)

  [ -z "$raw_criteria" ] && return 0

  local total met
  total=$(echo "$raw_criteria" | wc -l | grep -oE '[0-9]+' | head -1)
  met=$(echo "$raw_criteria" | grep -ci '\[x\]' | grep -oE '[0-9]+' | head -1 || echo 0)
  total=${total:-0}
  met=${met:-0}

  if [ "$met" -ge "$total" ] && [ "$total" -gt 0 ]; then
    echo "$MISSION_STATE_COMPLETE"
  elif [ "${pending_count:-0}" -eq 0 ]; then
    echo "$MISSION_STATE_REVIEWING"
  else
    echo "$MISSION_STATE_ACTIVE"
  fi
}

# ============================================================
# COMPLETION SUMMARY WRITER
# ============================================================

# Write a mission completion summary to .dev/mission-summary-<slug>.md.
# Gathers task stats from SQLite and success criteria from the mission file.
# Uses atomic write (tmp+mv) to prevent partial reads.
# Requires _db.sh to be sourced (for _db, _db_sep, DB_PATH).
#
# Usage: mission_write_completion_summary "/path/to/mission.md" "slug" ["output_dir"]
mission_write_completion_summary() {
  local mission_file="$1"
  local slug="$2"
  local output_dir="${3:-${DEV_DIR:-.dev}}"

  [ -f "$mission_file" ] || {
    if declare -f log >/dev/null 2>&1; then
      log "WARNING: Cannot write completion summary — mission file not found: $mission_file"
    fi
    return 1
  }

  # Need DB access for task stats
  [ -f "${DB_PATH:-/dev/null}" ] || {
    if declare -f log >/dev/null 2>&1; then
      log "WARNING: Cannot write completion summary — database not found"
    fi
    return 1
  }

  local slug_safe
  slug_safe=$(echo "$slug" | sed 's/[^a-zA-Z0-9]/_/g')
  local output="${output_dir}/mission-summary-${slug_safe}.md"
  local tmpfile="${output}.tmp.$$"
  local now
  now=$(date '+%Y-%m-%d %H:%M:%S')
  local today
  today=$(date '+%Y-%m-%d')

  # --- Gather task stats from SQLite ---
  local total_completed total_failed total_fixed total_blocked total_superseded
  total_completed=$(_db "SELECT COUNT(*) FROM tasks WHERE status IN ('completed','fixed');" 2>/dev/null || echo 0)
  total_failed=$(_db "SELECT COUNT(*) FROM tasks WHERE status = 'failed';" 2>/dev/null || echo 0)
  total_fixed=$(_db "SELECT COUNT(*) FROM tasks WHERE status = 'fixed';" 2>/dev/null || echo 0)
  total_blocked=$(_db "SELECT COUNT(*) FROM tasks WHERE status = 'blocked';" 2>/dev/null || echo 0)
  total_superseded=$(_db "SELECT COUNT(*) FROM tasks WHERE status = 'superseded';" 2>/dev/null || echo 0)

  # Total tasks ever created
  local total_tasks
  total_tasks=$(_db "SELECT COUNT(*) FROM tasks;" 2>/dev/null || echo 0)

  # Average duration (completed tasks only, stored as "Xm" text)
  local avg_duration
  avg_duration=$(_db "SELECT COALESCE(CAST(AVG(CAST(REPLACE(duration,'m','') AS INTEGER)) AS INTEGER), 0)
    FROM tasks WHERE status IN ('completed','fixed') AND duration IS NOT NULL AND duration != '';" 2>/dev/null || echo 0)

  # Self-correction rate: fixed / (failed + fixed)
  local fix_denominator fix_rate
  fix_denominator=$((total_failed + total_fixed))
  if [ "$fix_denominator" -gt 0 ]; then
    fix_rate=$(( (total_fixed * 100) / fix_denominator ))
  else
    fix_rate=0
  fi

  # --- Parse success criteria from mission file ---
  local criteria_section criteria_total criteria_met
  criteria_section=$(sed -n '/^## Success Criteria/,/^## /p' "$mission_file" \
    | grep '^[-*][[:space:]]*\[[ xX]\]' || true)
  if [ -n "$criteria_section" ]; then
    criteria_total=$(echo "$criteria_section" | wc -l | grep -oE '[0-9]+' | head -1)
    criteria_met=$(echo "$criteria_section" | grep -ci '\[x\]' | grep -oE '[0-9]+' | head -1 || echo 0)
  else
    criteria_total=0
    criteria_met=0
  fi
  criteria_total=${criteria_total:-0}
  criteria_met=${criteria_met:-0}

  # --- Extract mission title ---
  local mission_title
  mission_title=$(grep '^# ' "$mission_file" 2>/dev/null | head -1 | sed 's/^# *//')
  mission_title=${mission_title:-$slug}

  # --- Task breakdown by tag ---
  local tag_breakdown
  tag_breakdown=$(_db_sep "
    SELECT tag,
      COUNT(*) AS total,
      SUM(CASE WHEN status IN ('completed','fixed') THEN 1 ELSE 0 END) AS merged,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
    FROM tasks
    WHERE tag IS NOT NULL AND tag != ''
    GROUP BY tag
    ORDER BY COUNT(*) DESC;" 2>/dev/null || true)

  # --- Write the summary ---
  {
    echo "# Mission Completion Summary"
    echo ""
    echo "**Mission**: ${mission_title} | **Completed**: ${today} | **Status**: COMPLETE"
    echo ""
    echo "## Metrics"
    echo ""
    echo "| Metric | Value |"
    echo "|--------|-------|"
    echo "| Total tasks | ${total_tasks} |"
    echo "| Completed | ${total_completed} |"
    echo "| Failed (unresolved) | ${total_failed} |"
    echo "| Self-corrected (fixed) | ${total_fixed} |"
    echo "| Blocked | ${total_blocked} |"
    echo "| Superseded | ${total_superseded} |"
    echo "| Self-correction rate | ${fix_rate}% |"
    echo "| Avg task duration | ${avg_duration}m |"
    echo "| Success criteria | ${criteria_met}/${criteria_total} |"
    echo ""
    echo "## Task Breakdown by Category"
    echo ""
    echo "| Category | Total | Merged | Failed |"
    echo "|----------|-------|--------|--------|"
    if [ -n "$tag_breakdown" ]; then
      echo "$tag_breakdown" | while IFS="$_DB_SEP" read -r _tag _total _merged _failed; do
        echo "| [${_tag}] | ${_total} | ${_merged} | ${_failed} |"
      done
    else
      echo "| (no data) | 0 | 0 | 0 |"
    fi
    echo ""
    echo "## Success Criteria"
    echo ""
    if [ -n "$criteria_section" ]; then
      echo "$criteria_section"
    else
      echo "(no criteria defined)"
    fi
    echo ""
    echo "---"
    echo "*Generated at ${now}*"
  } > "$tmpfile"

  mv "$tmpfile" "$output"

  if declare -f log >/dev/null 2>&1; then
    log "Mission completion summary written to $output"
  fi

  # Emit event if available
  if declare -f emit_event >/dev/null 2>&1; then
    emit_event "mission_summary_written" "Summary for '$slug' written to $output (${total_completed} completed, ${total_failed} failed, fix_rate=${fix_rate}%)"
  fi

  echo "$output"
}
