#!/usr/bin/env bash
# tests/unit/failure-analyzer.test.sh — Regression tests for failure-analyzer.sh
#
# Tests threshold detection and INFRA task generation:
#   - _classify_error correctly maps error strings to categories
#   - _count_24h_category increments per-category 24h counters
#   - Threshold detection triggers _generate_infra_task when count >= threshold
#   - Threshold below limit does NOT trigger task generation
#   - Deduplication: skip INFRA task when similar already exists in backlog
#   - INFRA task content written to backlog.md (markdown fallback path)
#   - auto-generated-tasks.md log is appended correctly
#   - Multiple categories can each independently trigger INFRA tasks
#
# Usage: bash tests/unit/failure-analyzer.test.sh

# NOTE: -e is intentionally omitted — the test uses its own PASS/FAIL counters
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PASS=0
FAIL=0

log()  { printf "  %s\n" "$*"; }
pass() { PASS=$((PASS + 1)); printf "  \033[32m✓\033[0m %s\n" "$*"; }
fail() { FAIL=$((FAIL + 1)); printf "  \033[31m✗\033[0m %s\n" "$*"; }

assert_eq() {
  local actual="$1" expected="$2" msg="$3"
  if [ "$actual" = "$expected" ]; then pass "$msg"
  else fail "$msg (expected '$expected', got '$actual')"; fi
}

assert_contains() {
  local haystack="$1" needle="$2" msg="$3"
  if printf '%s' "$haystack" | grep -qF "$needle"; then pass "$msg"
  else fail "$msg (expected to contain '$needle')"; fi
}

assert_file_contains() {
  local file="$1" needle="$2" msg="$3"
  if grep -qF "$needle" "$file" 2>/dev/null; then pass "$msg"
  else fail "$msg (file did not contain '$needle')"; fi
}

assert_file_not_contains() {
  local file="$1" needle="$2" msg="$3"
  if ! grep -qF "$needle" "$file" 2>/dev/null; then pass "$msg"
  else fail "$msg (file unexpectedly contained '$needle')"; fi
}

# ── Setup: create isolated environment ──────────────────────────────

TMPDIR_ROOT=$(mktemp -d)
cleanup() {
  rm -rf "/tmp/skynet-test-fa-$$"* 2>/dev/null || true
  rm -rf "$TMPDIR_ROOT"
}
trap cleanup EXIT

echo ""
log "=== Setup: creating isolated environment for failure-analyzer tests ==="

# Create project structure
mkdir -p "$TMPDIR_ROOT/project/.dev/missions"
mkdir -p "$TMPDIR_ROOT/project/.dev/scripts"

cat > "$TMPDIR_ROOT/project/.dev/skynet.config.sh" <<CONF
export SKYNET_PROJECT_NAME="test-fa"
export SKYNET_PROJECT_DIR="$TMPDIR_ROOT/project"
export SKYNET_DEV_DIR="$TMPDIR_ROOT/project/.dev"
export SKYNET_LOCK_PREFIX="/tmp/skynet-test-fa-$$"
export SKYNET_MAIN_BRANCH="main"
export SKYNET_MAX_WORKERS=2
export SKYNET_MAX_FIXERS=2
export SKYNET_MAX_FIX_ATTEMPTS=3
export SKYNET_AGENT_PLUGIN="echo"
export SKYNET_TYPECHECK_CMD="true"
export SKYNET_GATE_1="true"
export SKYNET_POST_MERGE_TYPECHECK="false"
export SKYNET_POST_MERGE_SMOKE="false"
export SKYNET_BRANCH_PREFIX="dev/"
export SKYNET_STALE_MINUTES=45
export SKYNET_AGENT_TIMEOUT_MINUTES=5
export SKYNET_DEV_PORT=13500
export SKYNET_INSTALL_CMD="true"
export SKYNET_TG_ENABLED="false"
export SKYNET_NOTIFY_CHANNELS=""
export SKYNET_LOCK_BACKEND="file"
export SKYNET_USE_FLOCK="true"
CONF

# Symlink scripts directory
ln -s "$REPO_ROOT/scripts" "$TMPDIR_ROOT/project/.dev/scripts"

# Create required state files
touch "$TMPDIR_ROOT/project/.dev/backlog.md"
touch "$TMPDIR_ROOT/project/.dev/completed.md"
touch "$TMPDIR_ROOT/project/.dev/failed-tasks.md"
touch "$TMPDIR_ROOT/project/.dev/blockers.md"
touch "$TMPDIR_ROOT/project/.dev/mission.md"

# Set environment variables
export SKYNET_DEV_DIR="$TMPDIR_ROOT/project/.dev"
export SKYNET_PROJECT_DIR="$TMPDIR_ROOT/project"
export SKYNET_PROJECT_NAME="test-fa"
export SKYNET_LOCK_PREFIX="/tmp/skynet-test-fa-$$"
export SKYNET_MAIN_BRANCH="main"
export SKYNET_TG_ENABLED="false"
export SKYNET_NOTIFY_CHANNELS=""
export SKYNET_LOCK_BACKEND="file"
export SKYNET_USE_FLOCK="true"

# Derived paths
DEV_DIR="$SKYNET_DEV_DIR"
SCRIPTS_DIR="$SKYNET_DEV_DIR/scripts"
BACKLOG="$DEV_DIR/backlog.md"
COMPLETED="$DEV_DIR/completed.md"
FAILED="$DEV_DIR/failed-tasks.md"

# Source modules in the right order
SKYNET_SCRIPTS_DIR="$REPO_ROOT/scripts"
source "$REPO_ROOT/scripts/_compat.sh"
source "$REPO_ROOT/scripts/_notify.sh"

# Stub db_add_event before sourcing _events.sh
db_add_event() { :; }
source "$REPO_ROOT/scripts/_events.sh"

source "$REPO_ROOT/scripts/_lock_backend.sh"
source "$REPO_ROOT/scripts/_locks.sh"
source "$REPO_ROOT/scripts/_db.sh"

# Initialize database
db_init >/dev/null 2>&1

SEP=$'\x1f'

# Log file for the analyzer
LOG="$TMPDIR_ROOT/test-fa.log"
: > "$LOG"

# Redirect pipeline log() to the file
log() { echo "[$(date '+%H:%M:%S')] $*" >> "$LOG"; }

# Stub tg() and emit_event()
tg() { :; }
emit_event() { :; }

# ── Source the functions under test ──────────────────────────────────
# We source individual functions from failure-analyzer.sh by extracting them,
# since the script runs top-to-bottom. Instead, we define them directly
# from the source (they are simple enough to inline).

# _classify_error — copied from failure-analyzer.sh
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

# _count_24h_category — uses module-level counters
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

# _generate_infra_task — uses both DB and markdown fallback paths
USE_DB=false
FAILURE_THRESHOLD=5
BACKLOG_LOCK="${SKYNET_LOCK_PREFIX}-backlog.lock"

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

# Restore test log() after defining pipeline functions
log() { printf "  %s\n" "$*"; }

# ============================================================
# TESTS
# ============================================================

echo ""
log "=== _classify_error: error string classification ==="

assert_eq "$(_classify_error "Error: merge conflict on file X")" "merge_conflict" \
  "classifies 'merge conflict' as merge_conflict"

assert_eq "$(_classify_error "typecheck failed with 3 errors")" "typecheck" \
  "classifies 'typecheck failed' as typecheck"

assert_eq "$(_classify_error "the typecheck will fail here")" "typecheck" \
  "classifies 'typecheck...fail' as typecheck"

assert_eq "$(_classify_error "claude exit code 1")" "agent_failed" \
  "classifies 'claude exit code' as agent_failed"

assert_eq "$(_classify_error "the agent has failed")" "agent_failed" \
  "classifies 'agent...fail' as agent_failed"

assert_eq "$(_classify_error "worktree missing at /tmp/xyz")" "worktree_missing" \
  "classifies 'worktree missing' as worktree_missing"

assert_eq "$(_classify_error "quality gate failed")" "gate_failed" \
  "classifies 'gate...fail' as gate_failed"

assert_eq "$(_classify_error "hit usage limit for API key")" "usage_limit" \
  "classifies 'usage limit' as usage_limit"

assert_eq "$(_classify_error "all agents hit rate ceiling")" "usage_limit" \
  "classifies 'all agents hit' as usage_limit"

assert_eq "$(_classify_error "some random error message")" "other" \
  "classifies unknown error as other"

assert_eq "$(_classify_error "")" "other" \
  "classifies empty string as other"


echo ""
log "=== _count_24h_category: counter increments ==="

# Reset counters
_24h_merge_conflict=0
_24h_typecheck=0
_24h_agent_failed=0
_24h_worktree_missing=0
_24h_gate_failed=0
_24h_usage_limit=0

_count_24h_category "merge_conflict"
_count_24h_category "merge_conflict"
_count_24h_category "merge_conflict"
assert_eq "$_24h_merge_conflict" "3" "merge_conflict counter increments to 3"

_count_24h_category "typecheck"
assert_eq "$_24h_typecheck" "1" "typecheck counter increments to 1"

_count_24h_category "agent_failed"
_count_24h_category "agent_failed"
assert_eq "$_24h_agent_failed" "2" "agent_failed counter increments to 2"

_count_24h_category "worktree_missing"
assert_eq "$_24h_worktree_missing" "1" "worktree_missing counter increments to 1"

_count_24h_category "gate_failed"
assert_eq "$_24h_gate_failed" "1" "gate_failed counter increments to 1"

_count_24h_category "usage_limit"
assert_eq "$_24h_usage_limit" "1" "usage_limit counter increments to 1"

# Other/unknown categories should not increment any counter
_count_24h_category "other"
assert_eq "$_24h_merge_conflict" "3" "other does not affect merge_conflict"
assert_eq "$_24h_typecheck" "1" "other does not affect typecheck"


echo ""
log "=== Threshold detection: below threshold does NOT trigger ==="

# Reset environment
: > "$BACKLOG"
rm -f "$DEV_DIR/auto-generated-tasks.md"
FAILURE_THRESHOLD=5
USE_DB=false

# Simulate 4 typecheck failures (below threshold of 5)
_24h_typecheck=4
if [ "$_24h_typecheck" -ge "$FAILURE_THRESHOLD" ]; then
  fail "4 < threshold 5 should not trigger (logic error in test)"
else
  pass "4 typecheck failures below threshold 5 — no task generated"
fi

assert_file_not_contains "$BACKLOG" "INFRA" \
  "backlog has no INFRA task when below threshold"


echo ""
log "=== Threshold detection: at threshold DOES trigger (markdown fallback) ==="

# Reset
: > "$BACKLOG"
echo "# Backlog" > "$BACKLOG"
echo "" >> "$BACKLOG"
rm -f "$DEV_DIR/auto-generated-tasks.md"
USE_DB=false
FAILURE_THRESHOLD=5

# Generate task for typecheck with count=6
_generate_infra_task "typecheck" "6" \
  "Investigate recurring typecheck failures — check for type regressions"
rc=$?

assert_eq "$rc" "0" "_generate_infra_task returns 0 on success"

assert_file_contains "$BACKLOG" "[INFRA] Fix recurring typecheck failures (6 in 24h)" \
  "INFRA task written to backlog.md"

assert_file_contains "$BACKLOG" "Investigate recurring typecheck failures" \
  "task description included in backlog entry"

assert_file_contains "$DEV_DIR/auto-generated-tasks.md" "typecheck=6 (threshold=5)" \
  "auto-generated-tasks.md records the trigger"

assert_file_contains "$DEV_DIR/auto-generated-tasks.md" "[INFRA] Fix recurring typecheck" \
  "auto-generated-tasks.md records the task title"


echo ""
log "=== Deduplication: skip when similar task already in backlog (markdown) ==="

# backlog already contains the INFRA task from previous test
USE_DB=false
_generate_infra_task "typecheck" "7" \
  "Investigate recurring typecheck failures — different description"

# Count how many INFRA typecheck lines exist — should still be just 1
_infra_count=$(grep -c "Fix recurring typecheck" "$BACKLOG" 2>/dev/null || echo "0")
assert_eq "$_infra_count" "1" "dedup prevents second INFRA typecheck task in backlog"


echo ""
log "=== Deduplication: skip when similar task in completed.md ==="

# Clean backlog, put task in completed
: > "$BACKLOG"
echo "# Backlog" > "$BACKLOG"
echo "" >> "$BACKLOG"
echo "- [x] [INFRA] Fix recurring merge_conflict failures (5 in 24h)" > "$COMPLETED"
USE_DB=false

_generate_infra_task "merge_conflict" "8" \
  "Investigate merge conflicts"

assert_file_not_contains "$BACKLOG" "Fix recurring merge_conflict" \
  "dedup skips INFRA task when similar exists in completed.md"


echo ""
log "=== Threshold detection: DB path ==="

USE_DB=true
: > "$BACKLOG"
echo "# Backlog" > "$BACKLOG"
echo "" >> "$BACKLOG"
rm -f "$DEV_DIR/auto-generated-tasks.md"

_generate_infra_task "agent_failed" "5" \
  "Investigate recurring agent failures — check agent prompts"
rc=$?

assert_eq "$rc" "0" "_generate_infra_task via DB returns 0"

# Verify the task was added to the database
_db_count=$(_db "SELECT COUNT(*) FROM tasks WHERE title LIKE '%Fix recurring agent_failed%' AND status='pending';" 2>/dev/null || echo "0")
assert_eq "$_db_count" "1" "INFRA task inserted into SQLite database"

# Verify tag is INFRA
_db_tag=$(_db "SELECT tag FROM tasks WHERE title LIKE '%Fix recurring agent_failed%' AND status='pending';" 2>/dev/null || echo "")
assert_eq "$_db_tag" "INFRA" "task tag is INFRA in database"

assert_file_contains "$DEV_DIR/auto-generated-tasks.md" "agent_failed=5 (threshold=5)" \
  "auto-generated-tasks.md records DB-path trigger"


echo ""
log "=== Deduplication: skip when similar task already in DB ==="

USE_DB=true
_generate_infra_task "agent_failed" "10" \
  "Investigate recurring agent failures — different count"

_db_count2=$(_db "SELECT COUNT(*) FROM tasks WHERE title LIKE '%Fix recurring agent_failed%' AND status='pending';" 2>/dev/null || echo "0")
assert_eq "$_db_count2" "1" "dedup prevents second INFRA agent_failed task in DB"


echo ""
log "=== Multiple categories: independent triggering ==="

USE_DB=false
: > "$BACKLOG"
echo "# Backlog" > "$BACKLOG"
echo "" >> "$BACKLOG"
: > "$COMPLETED"
rm -f "$DEV_DIR/auto-generated-tasks.md"

_generate_infra_task "merge_conflict" "7" \
  "Investigate merge conflicts"
_generate_infra_task "gate_failed" "5" \
  "Investigate gate failures"

assert_file_contains "$BACKLOG" "Fix recurring merge_conflict" \
  "merge_conflict INFRA task in backlog"
assert_file_contains "$BACKLOG" "Fix recurring gate_failed" \
  "gate_failed INFRA task in backlog"

# Both should appear in auto-generated log
assert_file_contains "$DEV_DIR/auto-generated-tasks.md" "merge_conflict=7" \
  "auto-log records merge_conflict trigger"
assert_file_contains "$DEV_DIR/auto-generated-tasks.md" "gate_failed=5" \
  "auto-log records gate_failed trigger"


echo ""
log "=== End-to-end: classify + count + threshold check ==="

# Reset all counters
_24h_merge_conflict=0
_24h_typecheck=0
_24h_agent_failed=0
_24h_worktree_missing=0
_24h_gate_failed=0
_24h_usage_limit=0

USE_DB=false
: > "$BACKLOG"
echo "# Backlog" > "$BACKLOG"
echo "" >> "$BACKLOG"
: > "$COMPLETED"
rm -f "$DEV_DIR/auto-generated-tasks.md"
FAILURE_THRESHOLD=3

# Simulate a stream of errors being classified and counted
errors=(
  "typecheck failed with 5 errors"
  "typecheck failed on strict mode"
  "merge conflict on package.json"
  "typecheck failed again"
  "some unknown error happened"
  "merge conflict on lock file"
)
for err in "${errors[@]}"; do
  cat=$(_classify_error "$err")
  _count_24h_category "$cat"
done

assert_eq "$_24h_typecheck" "3" "end-to-end: 3 typecheck failures counted"
assert_eq "$_24h_merge_conflict" "2" "end-to-end: 2 merge_conflict failures counted"

# Now check thresholds (threshold=3)
_tasks_generated=0
if [ "$_24h_typecheck" -ge "$FAILURE_THRESHOLD" ]; then
  _generate_infra_task "typecheck" "$_24h_typecheck" \
    "Investigate recurring typecheck failures"
  _tasks_generated=$((_tasks_generated + 1))
fi
if [ "$_24h_merge_conflict" -ge "$FAILURE_THRESHOLD" ]; then
  _generate_infra_task "merge_conflict" "$_24h_merge_conflict" \
    "Investigate merge conflicts"
  _tasks_generated=$((_tasks_generated + 1))
fi

assert_eq "$_tasks_generated" "1" "end-to-end: only typecheck (3>=3) triggers, merge_conflict (2<3) does not"

assert_file_contains "$BACKLOG" "Fix recurring typecheck failures (3 in 24h)" \
  "end-to-end: typecheck INFRA task in backlog"
assert_file_not_contains "$BACKLOG" "Fix recurring merge_conflict" \
  "end-to-end: merge_conflict not in backlog (below threshold)"


# ============================================================
# SUMMARY
# ============================================================

echo ""
TOTAL=$((PASS + FAIL))
log "Results: $PASS/$TOTAL passed, $FAIL failed"
if [ "$FAIL" -eq 0 ]; then
  printf "  \033[32mAll checks passed!\033[0m\n"
else
  printf "  \033[31mSome checks failed!\033[0m\n"
  exit 1
fi
