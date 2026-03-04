#!/usr/bin/env bash
# _adaptive.sh — Adaptive task weighting based on lagging mission goals
# Sourced by _config.sh. Provides functions to boost priority of tasks
# aligned with lagging (unchecked) mission success criteria.
#
# How it works:
#   1. Parse the active mission's ## Goals and ## Success Criteria sections
#   2. Extract keywords from unchecked (lagging) criteria
#   3. Score pending tasks by keyword overlap with lagging goals
#   4. Apply priority boosts so lagging-goal-aligned tasks get claimed first
#
# Bash 3.2 compatible — no associative arrays, no ${VAR^^}.

# Default boost applied to tasks matching lagging goals (lower priority = claimed first).
# Configurable via SKYNET_ADAPTIVE_BOOST in skynet.config.sh or skynet.project.sh.
SKYNET_ADAPTIVE_BOOST="${SKYNET_ADAPTIVE_BOOST:-5}"

# Minimum word length for keyword extraction (matches TS extractMissionGoalKeywords).
_ADAPTIVE_MIN_WORD_LEN=4

# ── Keyword extraction ─────────────────────────────────────────────────

# Extract keywords from the ## Goals section of a mission file.
# Mirrors the TypeScript extractMissionGoalKeywords() in pipeline-status.ts.
# Output: one keyword per line, lowercased, >3 chars, deduplicated.
# Usage: keywords=$(_adaptive_goal_keywords "/path/to/mission.md")
_adaptive_goal_keywords() {
  local mission_file="${1:-}"
  [ -n "$mission_file" ] && [ -f "$mission_file" ] || return 0

  # Extract ## Goals section (everything between ## Goals and the next ## or EOF)
  sed -n '/^## Goals/,/^## /{ /^## Goals/d; /^## /d; p; }' "$mission_file" \
    | tr '[:upper:]' '[:lower:]' \
    | tr -cs '[:alnum:]' '\n' \
    | awk -v min="$_ADAPTIVE_MIN_WORD_LEN" 'length >= min' \
    | sort -u
}

# Extract keywords from unchecked (lagging) success criteria only.
# Parses "- [ ] ..." lines from ## Success Criteria section.
# Output: one keyword per line, lowercased, >3 chars, deduplicated.
# Usage: keywords=$(_adaptive_lagging_keywords "/path/to/mission.md")
_adaptive_lagging_keywords() {
  local mission_file="${1:-}"
  [ -n "$mission_file" ] && [ -f "$mission_file" ] || return 0

  # Extract ## Success Criteria section, then filter only unchecked items
  sed -n '/^## Success Criteria/,/^## /{ /^## /d; p; }' "$mission_file" \
    | grep -i '^\- \[ \]' \
    | tr '[:upper:]' '[:lower:]' \
    | tr -cs '[:alnum:]' '\n' \
    | awk -v min="$_ADAPTIVE_MIN_WORD_LEN" 'length >= min' \
    | sort -u
}

# Combined: get keywords from both Goals and lagging criteria.
# The union gives the broadest signal for matching tasks.
# Usage: keywords=$(_adaptive_all_lagging_keywords "/path/to/mission.md")
_adaptive_all_lagging_keywords() {
  local mission_file="${1:-}"
  { _adaptive_goal_keywords "$mission_file"; _adaptive_lagging_keywords "$mission_file"; } \
    | sort -u
}

# ── Task scoring ────────────────────────────────────────────────────────

# Check if a task title/tag matches any lagging goal keywords.
# Returns 0 (match) or 1 (no match) — suitable for if/then usage.
# Usage: if _adaptive_task_matches "Add burndown chart" "FEAT" "$keywords"; then ...
_adaptive_task_matches() {
  local title="$1"
  local tag="$2"
  local keywords="$3"  # newline-separated keyword list

  [ -n "$keywords" ] || return 1

  # Tokenize title+tag into lowercase words
  local task_words
  task_words=$(printf '%s %s' "$title" "$tag" \
    | tr '[:upper:]' '[:lower:]' \
    | tr -cs '[:alnum:]' '\n' \
    | awk -v min="$_ADAPTIVE_MIN_WORD_LEN" 'length >= min')

  # Check for any overlap
  local word
  while IFS= read -r word; do
    [ -n "$word" ] || continue
    if printf '%s\n' "$keywords" | grep -qx "$word"; then
      return 0
    fi
  done <<EOF
$task_words
EOF

  return 1
}

# Compute a priority boost for a task based on lagging goal alignment.
# Returns the boost value (negative offset = higher priority) or 0 if no match.
# Usage: boost=$(_adaptive_compute_boost "Add burndown chart" "FEAT" "$keywords")
_adaptive_compute_boost() {
  local title="$1"
  local tag="$2"
  local keywords="$3"

  if _adaptive_task_matches "$title" "$tag" "$keywords"; then
    echo "$SKYNET_ADAPTIVE_BOOST"
  else
    echo 0
  fi
}

# ── Batch reweighting ──────────────────────────────────────────────────

# Reweight all pending tasks in the database based on lagging goal alignment.
# Tasks matching lagging goals get their priority decreased (= higher urgency)
# by SKYNET_ADAPTIVE_BOOST. Tasks that don't match are reset to base priority.
#
# Uses an adaptive_offset column approach: stores the boost separately so
# base priority is never lost. If the column doesn't exist yet, adds it.
#
# Usage: _adaptive_reweight_pending [mission_file]
#        _adaptive_reweight_pending  (uses active mission)
_adaptive_reweight_pending() {
  local mission_file="${1:-}"
  if [ -z "$mission_file" ]; then
    mission_file="$(_resolve_active_mission)" 2>/dev/null || true
  fi

  if [ -z "$mission_file" ] || [ ! -f "$mission_file" ]; then
    return 0
  fi

  local keywords
  keywords=$(_adaptive_all_lagging_keywords "$mission_file")
  if [ -z "$keywords" ]; then
    return 0
  fi

  # Ensure adaptive_offset column exists
  _db_no_out "ALTER TABLE tasks ADD COLUMN adaptive_offset INTEGER DEFAULT 0;" 2>/dev/null || true

  # Get all pending tasks
  local pending
  pending=$(_db_sep "SELECT id, title, tag FROM tasks WHERE status = 'pending';")
  [ -n "$pending" ] || return 0

  local boosted=0
  local total=0

  while IFS="$_DB_SEP" read -r task_id task_title task_tag; do
    [ -n "$task_id" ] || continue
    total=$((total + 1))

    local boost
    boost=$(_adaptive_compute_boost "$task_title" "$task_tag" "$keywords")

    if [ "$boost" -gt 0 ]; then
      # Apply negative offset (lower priority number = higher urgency)
      _db_no_out "UPDATE tasks SET adaptive_offset = -${boost}, updated_at = datetime('now') WHERE id = $task_id AND adaptive_offset != -${boost};"
      boosted=$((boosted + 1))
    else
      # Reset offset if previously boosted
      _db_no_out "UPDATE tasks SET adaptive_offset = 0, updated_at = datetime('now') WHERE id = $task_id AND adaptive_offset != 0;"
    fi
  done <<EOF
$pending
EOF

  if [ "$boosted" -gt 0 ]; then
    log "ADAPTIVE: boosted $boosted/$total pending tasks aligned with lagging goals" 2>/dev/null || true
  fi
}

# ── Query helper ────────────────────────────────────────────────────────

# Returns the ORDER BY clause fragment for adaptive-weighted task claiming.
# If the adaptive_offset column exists, orders by (priority + adaptive_offset).
# Otherwise falls back to plain priority ordering.
# Usage: order_clause=$(_adaptive_order_clause)
_adaptive_order_clause() {
  # Check if adaptive_offset column exists
  local has_col
  has_col=$(_db "SELECT COUNT(*) FROM pragma_table_info('tasks') WHERE name = 'adaptive_offset';") 2>/dev/null || true

  if [ "${has_col:-0}" = "1" ]; then
    echo "(priority + COALESCE(adaptive_offset, 0)) ASC"
  else
    echo "priority ASC"
  fi
}

# ── Diagnostic ──────────────────────────────────────────────────────────

# Show current adaptive weighting state for debugging.
# Usage: _adaptive_status
_adaptive_status() {
  local mission_file
  mission_file="$(_resolve_active_mission)" 2>/dev/null || true

  echo "=== Adaptive Task Weighting Status ==="
  echo "Mission file: ${mission_file:-<none>}"
  echo "Boost value:  $SKYNET_ADAPTIVE_BOOST"
  echo ""

  if [ -n "$mission_file" ] && [ -f "$mission_file" ]; then
    local keywords
    keywords=$(_adaptive_all_lagging_keywords "$mission_file")
    if [ -n "$keywords" ]; then
      echo "Lagging goal keywords:"
      echo "$keywords" | sed 's/^/  - /'
    else
      echo "No lagging goal keywords found."
    fi
  else
    echo "No active mission found."
  fi

  echo ""
  echo "Boosted pending tasks:"
  _db "SELECT id, title, tag, priority, adaptive_offset FROM tasks WHERE status = 'pending' AND adaptive_offset != 0;" 2>/dev/null || echo "  (none or adaptive_offset column not yet created)"
}
