#!/usr/bin/env bash
# failure-analyzer.sh — Analyze failure patterns in the Skynet pipeline
# Reads from SQLite DB (primary) or failed-tasks.md (fallback) and reports
# error class distribution, retry success rates, and temporal clustering.
#
# Usage: bash scripts/failure-analyzer.sh [--json] [--days N]
#   --json   Output machine-readable JSON instead of text
#   --days N Only analyze failures from the last N days (default: all)

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_config.sh"

LOG="$LOG_DIR/failure-analyzer.log"
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

# --- Parse arguments ---
OUTPUT_FORMAT="text"
DAYS_FILTER=""
while [ $# -gt 0 ]; do
  case "$1" in
    --json) OUTPUT_FORMAT="json"; shift ;;
    --days) DAYS_FILTER="$2"; shift 2 ;;
    *) log "Unknown argument: $1"; exit 1 ;;
  esac
done

# Validate --days is numeric
if [ -n "$DAYS_FILTER" ]; then
  case "$DAYS_FILTER" in
    ''|*[!0-9]*) log "ERROR: --days must be a positive integer"; exit 1 ;;
  esac
fi

# --- Data source selection ---
USE_DB=false
if [ -f "$DB_PATH" ] && [ -s "$DB_PATH" ]; then
  # Check if tasks table has any failed/fixed/blocked rows
  _fail_count=$(_db "SELECT COUNT(*) FROM tasks WHERE status IN ('failed','blocked') OR (error IS NOT NULL AND error != '');" 2>/dev/null || echo "0")
  if [ "${_fail_count:-0}" -gt 0 ]; then
    USE_DB=true
  fi
fi

# --- Counters ---
total_failures=0
merge_conflict=0
typecheck_failed=0
agent_failed=0
worktree_missing=0
gate_failed=0
usage_limit=0
other_errors=0

fixed_count=0
superseded_count=0
blocked_count=0
still_failed=0

attempt_0=0
attempt_1=0
attempt_2=0
attempt_3_plus=0

# --- Classify an error string into a category ---
_classify_error() {
  local err="$1"
  case "$err" in
    *"merge conflict"*)    echo "merge_conflict" ;;
    *"typecheck failed"*)  echo "typecheck" ;;
    *"typecheck"*"fail"*)  echo "typecheck" ;;
    *"claude exit code"*)  echo "agent_failed" ;;
    *"agent"*"fail"*)      echo "agent_failed" ;;
    *"worktree missing"*)  echo "worktree_missing" ;;
    *"gate"*"fail"*)       echo "gate_failed" ;;
    *"usage limit"*)       echo "usage_limit" ;;
    *"all agents hit"*)    echo "usage_limit" ;;
    *)                     echo "other" ;;
  esac
}

# --- Increment error category counter ---
_count_error() {
  local cat="$1"
  case "$cat" in
    merge_conflict)  merge_conflict=$((merge_conflict + 1)) ;;
    typecheck)       typecheck_failed=$((typecheck_failed + 1)) ;;
    agent_failed)    agent_failed=$((agent_failed + 1)) ;;
    worktree_missing) worktree_missing=$((worktree_missing + 1)) ;;
    gate_failed)     gate_failed=$((gate_failed + 1)) ;;
    usage_limit)     usage_limit=$((usage_limit + 1)) ;;
    other)           other_errors=$((other_errors + 1)) ;;
  esac
}

# --- Increment status counter ---
_count_status() {
  local st="$1"
  case "$st" in
    fixed)      fixed_count=$((fixed_count + 1)) ;;
    superseded) superseded_count=$((superseded_count + 1)) ;;
    blocked)    blocked_count=$((blocked_count + 1)) ;;
    failed)     still_failed=$((still_failed + 1)) ;;
  esac
}

# --- Increment attempt counter ---
_count_attempts() {
  local att="$1"
  case "$att" in
    0) attempt_0=$((attempt_0 + 1)) ;;
    1) attempt_1=$((attempt_1 + 1)) ;;
    2) attempt_2=$((attempt_2 + 1)) ;;
    *) attempt_3_plus=$((attempt_3_plus + 1)) ;;
  esac
}

# --- Date filter helper: returns 1 if date is outside the window ---
_date_in_range() {
  [ -z "$DAYS_FILTER" ] && return 0
  local date_str="$1"
  # Extract just the date part (YYYY-MM-DD)
  local d="${date_str:0:10}"
  [ -z "$d" ] && return 1
  # Get epoch for the date and cutoff
  local date_epoch cutoff_epoch
  date_epoch=$(date -j -f "%Y-%m-%d" "$d" "+%s" 2>/dev/null || date -d "$d" "+%s" 2>/dev/null || echo "0")
  cutoff_epoch=$(date -v-"${DAYS_FILTER}d" "+%s" 2>/dev/null || date -d "-${DAYS_FILTER} days" "+%s" 2>/dev/null || echo "0")
  [ "$date_epoch" -ge "$cutoff_epoch" ] 2>/dev/null
}

# --- Collect top error messages for reporting ---
_error_messages=""
_record_error_msg() {
  local msg="$1"
  # Truncate long messages
  msg="${msg:0:120}"
  _error_messages="${_error_messages}${msg}"$'\n'
}

# ============================================================
# DATA COLLECTION
# ============================================================

if $USE_DB; then
  log "Analyzing failures from SQLite database"

  # Build date filter clause
  _where_date=""
  if [ -n "$DAYS_FILTER" ]; then
    _cutoff=$(date -v-"${DAYS_FILTER}d" "+%Y-%m-%d" 2>/dev/null || date -d "-${DAYS_FILTER} days" "+%Y-%m-%d" 2>/dev/null)
    if [ -n "$_cutoff" ]; then
      _where_date="AND (failed_at >= '$(_sql_escape "$_cutoff")' OR updated_at >= '$(_sql_escape "$_cutoff")')"
    fi
  fi

  # Query all tasks that have ever failed (including those later fixed/superseded)
  _rows=$(_db_sep "
    SELECT COALESCE(failed_at, updated_at, ''), COALESCE(error, ''), attempts, status
    FROM tasks
    WHERE (status IN ('failed', 'blocked') OR error IS NOT NULL AND error != '')
    $_where_date
    ORDER BY COALESCE(failed_at, updated_at) DESC;
  " 2>/dev/null) || _rows=""

  while IFS="$_DB_SEP" read -r _date _error _attempts _status; do
    [ -z "$_error" ] && [ -z "$_status" ] && continue
    total_failures=$((total_failures + 1))
    _cat=$(_classify_error "$_error")
    _count_error "$_cat"
    _count_status "$_status"
    _count_attempts "$_attempts"
    _record_error_msg "$_error"
  done <<< "$_rows"

else
  log "Analyzing failures from failed-tasks.md (SQLite DB empty or missing)"

  FAILED_FILE="$DEV_DIR/failed-tasks.md"
  if [ ! -f "$FAILED_FILE" ]; then
    log "No failure data found (no DB and no failed-tasks.md)"
    exit 0
  fi

  # Parse markdown table: | Date | Task | Branch | Error | Attempts | Status |
  # Skip header rows (first 2 lines after the heading)
  while IFS='|' read -r _ _date _task _branch _error _attempts _status _; do
    # Skip header/separator rows
    case "$_date" in *"Date"*|*"---"*) continue ;; esac
    # Trim whitespace
    _date=$(echo "$_date" | sed 's/^ *//;s/ *$//')
    _error=$(echo "$_error" | sed 's/^ *//;s/ *$//')
    _attempts=$(echo "$_attempts" | sed 's/^ *//;s/ *$//')
    _status=$(echo "$_status" | sed 's/^ *//;s/ *$//')

    [ -z "$_date" ] && continue

    # Apply date filter
    if ! _date_in_range "$_date"; then
      continue
    fi

    total_failures=$((total_failures + 1))
    _cat=$(_classify_error "$_error")
    _count_error "$_cat"
    _count_status "$_status"

    # Coerce attempts to integer
    case "$_attempts" in ''|*[!0-9]*) _attempts=0 ;; esac
    _count_attempts "$_attempts"
    _record_error_msg "$_error"
  done < "$FAILED_FILE"
fi

# ============================================================
# ANALYSIS
# ============================================================

# Calculate fix rate
if [ "$total_failures" -gt 0 ]; then
  fix_rate=$(( (fixed_count * 100) / total_failures ))
else
  fix_rate=0
fi

# Find top error pattern from collected messages
_top_error=""
_top_error_count=0
for _pattern in "merge conflict" "typecheck failed" "claude exit code" "worktree missing" "usage limit"; do
  _pc=$(printf '%s' "$_error_messages" | grep -ci "$_pattern" 2>/dev/null || echo "0")
  if [ "$_pc" -gt "$_top_error_count" ]; then
    _top_error_count=$_pc
    _top_error="$_pattern"
  fi
done

# ============================================================
# OUTPUT
# ============================================================

if [ "$OUTPUT_FORMAT" = "json" ]; then
  cat <<ENDJSON
{
  "total_failures": $total_failures,
  "error_classes": {
    "merge_conflict": $merge_conflict,
    "typecheck_failed": $typecheck_failed,
    "agent_failed": $agent_failed,
    "worktree_missing": $worktree_missing,
    "gate_failed": $gate_failed,
    "usage_limit": $usage_limit,
    "other": $other_errors
  },
  "outcomes": {
    "fixed": $fixed_count,
    "superseded": $superseded_count,
    "blocked": $blocked_count,
    "still_failed": $still_failed
  },
  "retry_distribution": {
    "attempt_0": $attempt_0,
    "attempt_1": $attempt_1,
    "attempt_2": $attempt_2,
    "attempt_3_plus": $attempt_3_plus
  },
  "fix_rate_pct": $fix_rate,
  "top_error_pattern": "$(_sql_escape "${_top_error:-none}")",
  "data_source": "$(if $USE_DB; then echo "sqlite"; else echo "markdown"; fi)"
}
ENDJSON
else
  echo ""
  echo "=== Skynet Failure Pattern Analysis ==="
  echo ""
  echo "Data source: $(if $USE_DB; then echo "SQLite DB"; else echo "failed-tasks.md"; fi)"
  if [ -n "$DAYS_FILTER" ]; then
    echo "Date range:  last $DAYS_FILTER days"
  fi
  echo "Total failures analyzed: $total_failures"
  echo ""

  if [ "$total_failures" -eq 0 ]; then
    echo "No failures found. Pipeline is clean."
    exit 0
  fi

  echo "--- Error Classes ---"
  printf "  %-20s %d\n" "Merge conflict" "$merge_conflict"
  printf "  %-20s %d\n" "Typecheck failed" "$typecheck_failed"
  printf "  %-20s %d\n" "Agent failed" "$agent_failed"
  printf "  %-20s %d\n" "Worktree missing" "$worktree_missing"
  printf "  %-20s %d\n" "Gate failed" "$gate_failed"
  printf "  %-20s %d\n" "Usage limit" "$usage_limit"
  printf "  %-20s %d\n" "Other" "$other_errors"
  echo ""

  echo "--- Outcomes ---"
  printf "  %-20s %d\n" "Fixed" "$fixed_count"
  printf "  %-20s %d\n" "Superseded" "$superseded_count"
  printf "  %-20s %d\n" "Blocked" "$blocked_count"
  printf "  %-20s %d\n" "Still failed" "$still_failed"
  printf "  %-20s %d%%\n" "Fix rate" "$fix_rate"
  echo ""

  echo "--- Retry Distribution ---"
  printf "  %-20s %d\n" "0 attempts" "$attempt_0"
  printf "  %-20s %d\n" "1 attempt" "$attempt_1"
  printf "  %-20s %d\n" "2 attempts" "$attempt_2"
  printf "  %-20s %d\n" "3+ attempts" "$attempt_3_plus"
  echo ""

  if [ -n "$_top_error" ]; then
    echo "--- Top Pattern ---"
    echo "  Most common: $_top_error ($_top_error_count occurrences)"
    echo ""
  fi

  # Actionable insights
  echo "--- Insights ---"
  if [ "$merge_conflict" -gt 0 ] && [ "$total_failures" -gt 0 ]; then
    _mc_pct=$(( (merge_conflict * 100) / total_failures ))
    if [ "$_mc_pct" -ge 40 ]; then
      echo "  [!] Merge conflicts are ${_mc_pct}% of failures. Consider reducing concurrent workers or enabling rebase-before-push."
    fi
  fi
  if [ "$typecheck_failed" -gt 0 ] && [ "$total_failures" -gt 0 ]; then
    _tc_pct=$(( (typecheck_failed * 100) / total_failures ))
    if [ "$_tc_pct" -ge 30 ]; then
      echo "  [!] Typecheck failures are ${_tc_pct}% of failures. Check for type regressions or missing exports."
    fi
  fi
  if [ "$blocked_count" -gt 0 ]; then
    echo "  [!] $blocked_count task(s) blocked after max retry attempts. Check blockers.md for required manual intervention."
  fi
  if [ "$attempt_3_plus" -gt 0 ] && [ "$total_failures" -gt 0 ]; then
    _retry_pct=$(( (attempt_3_plus * 100) / total_failures ))
    if [ "$_retry_pct" -ge 20 ]; then
      echo "  [!] ${_retry_pct}% of failures needed 3+ attempts. Consider decomposing complex tasks."
    fi
  fi
  if [ "$fix_rate" -ge 80 ]; then
    echo "  [+] Fix rate is ${fix_rate}% — task-fixer is effective."
  elif [ "$fix_rate" -lt 50 ] && [ "$total_failures" -gt 5 ]; then
    echo "  [!] Fix rate is only ${fix_rate}%. Task-fixer may need tuning."
  fi
  echo ""
fi

# ============================================================
# FAILURE PATTERN THRESHOLD DETECTOR
# ============================================================
# Counts failures by error category within a 24h window.
# When any category hits the threshold (default: 5), generates
# a targeted [INFRA] task and prepends it to the backlog.

FAILURE_THRESHOLD="${SKYNET_FAILURE_THRESHOLD:-5}"
BACKLOG_LOCK="${SKYNET_LOCK_PREFIX}-backlog.lock"

# Count failures by category in the last 24 hours
_24h_merge_conflict=0
_24h_typecheck=0
_24h_agent_failed=0
_24h_worktree_missing=0
_24h_gate_failed=0
_24h_usage_limit=0

_count_24h_category() {
  local cat="$1"
  case "$cat" in
    merge_conflict)   _24h_merge_conflict=$((_24h_merge_conflict + 1)) ;;
    typecheck)        _24h_typecheck=$((_24h_typecheck + 1)) ;;
    agent_failed)     _24h_agent_failed=$((_24h_agent_failed + 1)) ;;
    worktree_missing) _24h_worktree_missing=$((_24h_worktree_missing + 1)) ;;
    gate_failed)      _24h_gate_failed=$((_24h_gate_failed + 1)) ;;
    usage_limit)      _24h_usage_limit=$((_24h_usage_limit + 1)) ;;
  esac
}

# Collect 24h failure counts from DB or markdown
_cutoff_24h=$(date -v-1d "+%Y-%m-%d %H:%M:%S" 2>/dev/null || date -d "-1 day" "+%Y-%m-%d %H:%M:%S" 2>/dev/null)
_cutoff_24h_date="${_cutoff_24h:0:10}"

if $USE_DB; then
  _rows_24h=$(_db_sep "
    SELECT COALESCE(error, ''), status
    FROM tasks
    WHERE status IN ('failed', 'blocked')
      AND COALESCE(failed_at, updated_at) >= '$(_sql_escape "$_cutoff_24h")'
    ORDER BY COALESCE(failed_at, updated_at) DESC;
  " 2>/dev/null) || _rows_24h=""

  while IFS="$_DB_SEP" read -r _err24 _st24; do
    [ -z "$_err24" ] && continue
    _cat24=$(_classify_error "$_err24")
    _count_24h_category "$_cat24"
  done <<< "$_rows_24h"
else
  if [ -f "$FAILED_FILE" ]; then
    while IFS='|' read -r _ _d24 _t24 _b24 _e24 _a24 _s24 _; do
      case "$_d24" in *"Date"*|*"---"*) continue ;; esac
      _d24=$(echo "$_d24" | sed 's/^ *//;s/ *$//')
      _e24=$(echo "$_e24" | sed 's/^ *//;s/ *$//')
      _s24=$(echo "$_s24" | sed 's/^ *//;s/ *$//')
      [ -z "$_d24" ] && continue
      # Only count failed/blocked within last 24h
      case "$_s24" in failed|blocked) ;; *) continue ;; esac
      # Simple date comparison (YYYY-MM-DD >= cutoff date)
      _d24_date="${_d24:0:10}"
      [ "$_d24_date" \< "$_cutoff_24h_date" ] && continue
      _cat24=$(_classify_error "$_e24")
      _count_24h_category "$_cat24"
    done < "$FAILED_FILE"
  fi
fi

# --- Check thresholds and generate INFRA tasks ---
_generate_infra_task() {
  local category="$1" count="$2" description="$3"
  local task_title="[INFRA] Fix recurring $category failures ($count in 24h)"

  # Dedup: check if this task (or similar) already exists in backlog or completed
  if $USE_DB; then
    local _existing
    _existing=$(_db "SELECT COUNT(*) FROM tasks WHERE status IN ('pending','claimed','fixing-1','fixing-2','fixing-3')
      AND title LIKE '%Fix recurring ${category}%';" 2>/dev/null || echo "0")
    if [ "${_existing:-0}" -gt 0 ]; then
      log "Skipping auto-INFRA for $category — similar task already in backlog"
      return 0
    fi
  else
    if [ -f "$BACKLOG" ] && grep -qi "Fix recurring ${category}" "$BACKLOG" 2>/dev/null; then
      log "Skipping auto-INFRA for $category — similar task already in backlog"
      return 0
    fi
    if [ -f "$COMPLETED" ] && grep -qi "Fix recurring ${category}" "$COMPLETED" 2>/dev/null; then
      log "Skipping auto-INFRA for $category — similar task recently completed"
      return 0
    fi
  fi

  log "Threshold hit: $category has $count failures in 24h (threshold: $FAILURE_THRESHOLD)"

  # Add task via DB if available, otherwise prepend to backlog.md with lock
  if $USE_DB; then
    local _new_id
    _new_id=$(db_add_task "$task_title" "INFRA" "$description" "top")
    if [ -n "$_new_id" ] && [ "$_new_id" -gt 0 ] 2>/dev/null; then
      db_export_backlog "$BACKLOG" 2>/dev/null || true
      log "Auto-generated INFRA task #$_new_id: $task_title"
    else
      log "ERROR: Failed to add auto-INFRA task for $category"
      return 1
    fi
  else
    # Fallback: prepend to backlog.md with mkdir lock
    local _max_wait=50 _waited=0
    while ! mkdir "$BACKLOG_LOCK" 2>/dev/null; do
      _waited=$((_waited + 1))
      if [ "$_waited" -ge "$_max_wait" ]; then
        log "ERROR: Could not acquire backlog lock for auto-INFRA task"
        return 1
      fi
      sleep 0.1
    done
    echo $$ > "$BACKLOG_LOCK/pid" 2>/dev/null || true

    if [ -f "$BACKLOG" ]; then
      local _tmpbl
      _tmpbl=$(mktemp /tmp/skynet-fa-backlog-XXXXXX)
      # Insert new task after the header comments (first blank line after comments)
      awk -v task="- [ ] $task_title — $description" '
        /^$/ && !inserted && header_done { print task; inserted=1 }
        /^#|^<!--/ { header_done=1 }
        { print }
        END { if (!inserted) print task }
      ' "$BACKLOG" > "$_tmpbl"
      mv "$_tmpbl" "$BACKLOG"
      log "Auto-generated INFRA task (markdown): $task_title"
    fi

    rmdir "$BACKLOG_LOCK" 2>/dev/null || rm -rf "$BACKLOG_LOCK" 2>/dev/null || true
  fi

  # Log to auto-generated-tasks record
  local _auto_log="$DEV_DIR/auto-generated-tasks.md"
  if [ ! -f "$_auto_log" ]; then
    printf '# Auto-Generated Tasks\n\n| Date | Task | Trigger |\n|------|------|---------|\n' > "$_auto_log"
  fi
  printf '| %s | %s | %s=%d (threshold=%d) |\n' \
    "$(date '+%Y-%m-%d %H:%M')" "$task_title" "$category" "$count" "$FAILURE_THRESHOLD" >> "$_auto_log"

  return 0
}

# Check each category against threshold
_tasks_generated=0
if [ "$_24h_merge_conflict" -ge "$FAILURE_THRESHOLD" ]; then
  _generate_infra_task "merge_conflict" "$_24h_merge_conflict" \
    "Investigate and fix root cause of merge conflicts — consider reducing concurrent workers, improving rebase strategy, or isolating conflicting file paths"
  _tasks_generated=$((_tasks_generated + 1))
fi
if [ "$_24h_typecheck" -ge "$FAILURE_THRESHOLD" ]; then
  _generate_infra_task "typecheck" "$_24h_typecheck" \
    "Investigate recurring typecheck failures — check for type regressions, missing exports, or incompatible dependency updates"
  _tasks_generated=$((_tasks_generated + 1))
fi
if [ "$_24h_agent_failed" -ge "$FAILURE_THRESHOLD" ]; then
  _generate_infra_task "agent_failed" "$_24h_agent_failed" \
    "Investigate recurring agent failures — check agent prompts, context limits, or task complexity issues"
  _tasks_generated=$((_tasks_generated + 1))
fi
if [ "$_24h_worktree_missing" -ge "$FAILURE_THRESHOLD" ]; then
  _generate_infra_task "worktree_missing" "$_24h_worktree_missing" \
    "Investigate recurring worktree setup failures — check disk space, git state, or worktree cleanup logic"
  _tasks_generated=$((_tasks_generated + 1))
fi
if [ "$_24h_gate_failed" -ge "$FAILURE_THRESHOLD" ]; then
  _generate_infra_task "gate_failed" "$_24h_gate_failed" \
    "Investigate recurring quality gate failures — review gate scripts, thresholds, or environment dependencies"
  _tasks_generated=$((_tasks_generated + 1))
fi
if [ "$_24h_usage_limit" -ge "$FAILURE_THRESHOLD" ]; then
  _generate_infra_task "usage_limit" "$_24h_usage_limit" \
    "Investigate recurring usage limit failures — check API key rotation, rate limiting, or agent pool sizing"
  _tasks_generated=$((_tasks_generated + 1))
fi

if [ "$_tasks_generated" -gt 0 ]; then
  log "Auto-generated $_tasks_generated INFRA task(s) from failure pattern detection"
fi

log "Analysis complete: $total_failures failures analyzed"
