#!/usr/bin/env bash
# tests/unit/project-driver.test.sh — Unit tests for project-driver.sh backlog generation
#
# Tests: _normalize_task_line normalization, dedup snapshot building from
# backlog/completed/failed state files, post-agent backlog deduplication,
# reconciliation tag/title parsing, and task count sanitization.
#
# Usage: bash tests/unit/project-driver.test.sh

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
  if [ "$actual" = "$expected" ]; then
    pass "$msg"
  else
    fail "$msg (expected '$expected', got '$actual')"
  fi
}

assert_contains() {
  local haystack="$1" needle="$2" msg="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    pass "$msg"
  else
    fail "$msg (expected to contain '$needle')"
  fi
}

assert_not_contains() {
  local haystack="$1" needle="$2" msg="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    fail "$msg (should NOT contain '$needle')"
  else
    pass "$msg"
  fi
}

assert_not_empty() {
  local val="$1" msg="$2"
  if [ -n "$val" ]; then pass "$msg"
  else fail "$msg (was empty)"; fi
}

assert_empty() {
  local val="$1" msg="$2"
  if [ -z "$val" ]; then pass "$msg"
  else fail "$msg (expected empty, got '$val')"; fi
}

assert_line_count() {
  local content="$1" expected="$2" msg="$3"
  local actual=0
  if [ -n "$content" ]; then
    actual=$(printf '%s\n' "$content" | wc -l | tr -d ' ')
  fi
  if [ "$actual" = "$expected" ]; then
    pass "$msg"
  else
    fail "$msg (expected $expected lines, got $actual)"
  fi
}

# ── Setup: create isolated environment ──────────────────────────────

TMPDIR_ROOT=$(mktemp -d)
cleanup() { rm -rf "$TMPDIR_ROOT"; }
trap cleanup EXIT

# Extract _normalize_task_line from the actual script (tests real code, not a copy)
eval "$(sed -n '/^_normalize_task_line()/,/^}/p' "$REPO_ROOT/scripts/project-driver.sh")"

# ── Mock environment for full-script tests ──────────────────────────

MOCK_SCRIPTS_DIR="$TMPDIR_ROOT/scripts"
MOCK_DEV_DIR="$TMPDIR_ROOT/.dev"
MOCK_PROJECT_DIR="$TMPDIR_ROOT/project"
mkdir -p "$MOCK_SCRIPTS_DIR" "$MOCK_DEV_DIR" "$MOCK_PROJECT_DIR" \
  "$MOCK_DEV_DIR/missions" "$TMPDIR_ROOT/locks"

# Copy script under test
cp "$REPO_ROOT/scripts/project-driver.sh" "$MOCK_SCRIPTS_DIR/project-driver.sh"

# Write mock auth-check.sh
cat > "$MOCK_SCRIPTS_DIR/auth-check.sh" << 'AUTHSTUB'
# Mock auth-check — always succeeds
check_any_auth() { return 0; }
AUTHSTUB

# Write mock _config.sh with all required variables and function stubs
write_mock_config() {
  cat > "$MOCK_SCRIPTS_DIR/_config.sh" << CFGSTUB
SCRIPTS_DIR="$MOCK_SCRIPTS_DIR"
SKYNET_SCRIPTS_DIR="$MOCK_SCRIPTS_DIR"
PROJECT_DIR="$MOCK_PROJECT_DIR"
SKYNET_PROJECT_DIR="$MOCK_PROJECT_DIR"
DEV_DIR="$MOCK_DEV_DIR"
SKYNET_DEV_DIR="$MOCK_DEV_DIR"
SKYNET_LOCK_PREFIX="$TMPDIR_ROOT/locks/skynet-test"
SKYNET_PROJECT_NAME="test-pd"
SKYNET_PROJECT_NAME_UPPER="TEST-PD"
SKYNET_PROJECT_VISION="Test project vision"
BACKLOG="$MOCK_DEV_DIR/backlog.md"
COMPLETED="$MOCK_DEV_DIR/completed.md"
FAILED="$MOCK_DEV_DIR/failed-tasks.md"
CURRENT_TASK="$MOCK_DEV_DIR/current-task.md"
BLOCKERS="$MOCK_DEV_DIR/blockers.md"
SYNC_HEALTH="$MOCK_DEV_DIR/sync-health.md"
MISSION="$MOCK_DEV_DIR/mission.md"
MISSION_CONFIG="$MOCK_DEV_DIR/missions/_config.json"
MISSIONS_DIR="$MOCK_DEV_DIR/missions"

_require_db() { :; }
_resolve_active_mission() { echo ""; }
_get_active_mission_slug() { echo ""; }

# Mock _db: returns titles from MOCK_DB_TITLES_FILE for SELECT title queries,
# returns "0" for all other (count) queries.
_db() {
  local q="\$1"
  case "\$q" in
    *"SELECT title FROM tasks"*)
      if [ -f "\${MOCK_DB_TITLES_FILE:-/dev/null}" ]; then
        cat "\${MOCK_DB_TITLES_FILE}"
      fi
      ;;
    *) echo "0" ;;
  esac
}

db_export_context() { echo ""; }
db_export_context_for_mission() { echo ""; }
db_count_pending() { echo "\${MOCK_DB_PENDING:-0}"; }
db_count_claimed() { echo "\${MOCK_DB_CLAIMED:-0}"; }
db_count_by_status() { echo "\${MOCK_DB_STATUS_COUNT:-0}"; }
db_count_pending_for_mission() { echo "0"; }
db_count_claimed_for_mission() { echo "0"; }

# Mock db_task_exists: checks MOCK_DB_TASKS_FILE for exact match
db_task_exists() {
  if [ -f "\${MOCK_DB_TASKS_FILE:-}" ]; then
    grep -qxF "\$1" "\${MOCK_DB_TASKS_FILE}" 2>/dev/null
    return \$?
  fi
  return 1
}

# Mock db_add_task: records title|tag|desc to MOCK_DB_ADDED_FILE
db_add_task() {
  printf '%s|%s|%s\n' "\$1" "\$2" "\$3" >> "\${MOCK_DB_ADDED_FILE:-/dev/null}"
  return 0
}

db_export_state_files() { :; }
db_count_active_blockers() { echo "0"; }

# Mock run_agent: copies MOCK_AGENT_OUTPUT to BACKLOG
run_agent() {
  if [ -f "\${MOCK_AGENT_OUTPUT:-}" ]; then
    cp "\${MOCK_AGENT_OUTPUT}" "\$BACKLOG"
  fi
  return \${MOCK_AGENT_EXIT_CODE:-0}
}

emit_event() { :; }
tg() { :; }

_log() {
  local level="\$1" label="\$2" msg="\$3" logfile="\${4:-}"
  if [ -n "\$logfile" ]; then
    printf '%s\n' "[\$label] \$msg" >> "\$logfile"
  fi
}
CFGSTUB
}

# Create default mission file
write_mission() {
  cat > "$MOCK_DEV_DIR/mission.md" << 'MISSION'
# Test Mission

Build a test project.

## Success Criteria

- [ ] Feature A implemented
- [ ] Feature B implemented
MISSION
}

# Reset state between tests
reset_state() {
  rm -f "$MOCK_DEV_DIR/backlog.md" "$MOCK_DEV_DIR/completed.md" \
    "$MOCK_DEV_DIR/failed-tasks.md" "$MOCK_DEV_DIR/current-task.md" \
    "$MOCK_DEV_DIR/blockers.md" "$MOCK_DEV_DIR/sync-health.md" \
    "$MOCK_DEV_DIR/pipeline-paused" "$MOCK_DEV_DIR/mission-complete-global"
  rm -rf "$TMPDIR_ROOT/locks"
  mkdir -p "$TMPDIR_ROOT/locks"
  rm -f "$TMPDIR_ROOT/agent_output.md" "$TMPDIR_ROOT/db_tasks.txt" \
    "$TMPDIR_ROOT/db_titles.txt" "$TMPDIR_ROOT/db_added.txt"
  unset MOCK_AGENT_OUTPUT MOCK_AGENT_EXIT_CODE MOCK_DB_TITLES_FILE \
    MOCK_DB_TASKS_FILE MOCK_DB_ADDED_FILE MOCK_DB_PENDING \
    MOCK_DB_CLAIMED MOCK_DB_STATUS_COUNT 2>/dev/null || true
  write_mission
  write_mock_config
}

# Run project-driver.sh and capture outputs.
# Sets: _rc (exit code), _output (stdout+stderr), _backlog (backlog.md content)
run_project_driver() {
  local run_log="$TMPDIR_ROOT/run.log"
  rm -f "$run_log"
  _rc=0
  (
    export MOCK_AGENT_OUTPUT="${MOCK_AGENT_OUTPUT:-}"
    export MOCK_AGENT_EXIT_CODE="${MOCK_AGENT_EXIT_CODE:-0}"
    export MOCK_DB_TITLES_FILE="${MOCK_DB_TITLES_FILE:-}"
    export MOCK_DB_TASKS_FILE="${MOCK_DB_TASKS_FILE:-}"
    export MOCK_DB_ADDED_FILE="${MOCK_DB_ADDED_FILE:-}"
    export MOCK_DB_PENDING="${MOCK_DB_PENDING:-0}"
    export MOCK_DB_CLAIMED="${MOCK_DB_CLAIMED:-0}"
    export MOCK_DB_STATUS_COUNT="${MOCK_DB_STATUS_COUNT:-0}"
    bash "$MOCK_SCRIPTS_DIR/project-driver.sh" >> "$run_log" 2>&1
  ) || _rc=$?
  _output=""
  [ -f "$run_log" ] && _output=$(cat "$run_log")
  _backlog=""
  [ -f "$MOCK_DEV_DIR/backlog.md" ] && _backlog=$(cat "$MOCK_DEV_DIR/backlog.md")
  _db_added=""
  [ -f "$TMPDIR_ROOT/db_added.txt" ] && _db_added=$(cat "$TMPDIR_ROOT/db_added.txt")
}

echo "project-driver.test.sh — unit tests for project-driver.sh backlog generation"

# ══════════════════════════════════════════════════════════════════════
# NORMALIZE TASK LINE TESTS
# ══════════════════════════════════════════════════════════════════════

echo ""
log "=== _normalize_task_line: checkbox stripping ==="

result=$(_normalize_task_line "- [ ] [FEAT] Add user auth")
assert_eq "$result" "add user auth" "strips pending checkbox and tag"

result=$(_normalize_task_line "- [x] [FIX] Fix login bug")
assert_eq "$result" "fix login bug" "strips done checkbox and tag"

result=$(_normalize_task_line "- [>] [INFRA] Setup CI pipeline")
assert_eq "$result" "setup ci pipeline" "strips claimed checkbox and tag"

echo ""
log "=== _normalize_task_line: tag stripping ==="

result=$(_normalize_task_line "- [ ] [TEST] Add unit tests for auth module")
assert_eq "$result" "add unit tests for auth module" "strips [TEST] tag"

result=$(_normalize_task_line "- [ ] [DATA] Sync user records from external API")
assert_eq "$result" "sync user records from external api" "strips [DATA] tag"

result=$(_normalize_task_line "- [ ] [NMI] Investigate flaky test in merge flow")
assert_eq "$result" "investigate flaky test in merge flow" "strips [NMI] tag"

echo ""
log "=== _normalize_task_line: case normalization ==="

result=$(_normalize_task_line "- [ ] [FEAT] Add OAUTH2 Support for GITHUB Integration")
assert_eq "$result" "add oauth2 support for github integration" "lowercases all text"

echo ""
log "=== _normalize_task_line: whitespace handling ==="

result=$(_normalize_task_line "- [ ] [FIX]   Fix   multiple   spaces   in   output")
assert_eq "$result" "fix multiple spaces in output" "collapses multiple spaces"

result=$(_normalize_task_line "- [ ] [FEAT]  leading and trailing spaces  ")
assert_eq "$result" "leading and trailing spaces" "trims leading and trailing spaces"

echo ""
log "=== _normalize_task_line: truncation to 60 chars ==="

long_task="- [ ] [FEAT] This is a very long task title that should definitely be truncated at exactly sixty characters for dedup matching"
result=$(_normalize_task_line "$long_task")
assert_eq "${#result}" "60" "truncates to 60 characters"
assert_eq "$result" "this is a very long task title that should definitely be tru" "correct truncation content"

echo ""
log "=== _normalize_task_line: edge cases ==="

result=$(_normalize_task_line "[FEAT] Some task without checkbox")
assert_eq "$result" "some task without checkbox" "handles bare tag without checkbox"

result=$(_normalize_task_line "plain text without any prefix")
assert_eq "$result" "plain text without any prefix" "passes through plain text"

result=$(_normalize_task_line "- [ ] No tag just a task")
assert_eq "$result" "no tag just a task" "handles task without tag"

# ══════════════════════════════════════════════════════════════════════
# TASK COUNT SANITIZATION TESTS
# ══════════════════════════════════════════════════════════════════════
# project-driver.sh uses this pattern throughout to sanitize counts:
#   val=${val:-0}; case "$val" in ''|*[!0-9]*) val=0 ;; esac

echo ""
log "=== Task count sanitization ==="

sanitize_count() {
  local val="$1"
  val=${val:-0}
  case "$val" in ''|*[!0-9]*) val=0 ;; esac
  echo "$val"
}

assert_eq "$(sanitize_count "")" "0" "empty string → 0"
assert_eq "$(sanitize_count "abc")" "0" "non-numeric string → 0"
assert_eq "$(sanitize_count "12abc")" "0" "mixed string → 0"
assert_eq "$(sanitize_count "5")" "5" "valid number preserved"
assert_eq "$(sanitize_count "0")" "0" "zero preserved"
assert_eq "$(sanitize_count "  3  ")" "0" "number with spaces → 0 (not pure digits)"

# ══════════════════════════════════════════════════════════════════════
# DEDUP SNAPSHOT BUILDING FROM STATE FILES
# ══════════════════════════════════════════════════════════════════════
# These tests verify the file-parsing patterns used by project-driver.sh
# to build the pre-agent dedup snapshot from backlog, completed, and failed files.

echo ""
log "=== Dedup snapshot: backlog.md parsing ==="

# Simulate the grep pattern from project-driver.sh lines 370-373
_test_backlog="$TMPDIR_ROOT/test_backlog.md"
cat > "$_test_backlog" << 'EOF'
# Backlog
- [ ] [FEAT] Add user auth
- [>] [FIX] Fix login bug
- [x] [INFRA] Setup CI
- Not a task line
## Section header
- [ ] [TEST] Add tests
EOF

snapshot=$(grep '^\- \[[ >x]\]' "$_test_backlog" 2>/dev/null || true)
assert_contains "$snapshot" "- [ ] [FEAT] Add user auth" "captures pending tasks"
assert_contains "$snapshot" "- [>] [FIX] Fix login bug" "captures claimed tasks"
assert_contains "$snapshot" "- [x] [INFRA] Setup CI" "captures done tasks"
assert_contains "$snapshot" "- [ ] [TEST] Add tests" "captures tasks after headers"
assert_not_contains "$snapshot" "Not a task line" "excludes non-task lines"
assert_not_contains "$snapshot" "Section header" "excludes section headers"

echo ""
log "=== Dedup snapshot: completed.md parsing ==="

# Simulate the awk pattern from project-driver.sh lines 376-382
_test_completed="$TMPDIR_ROOT/test_completed.md"
cat > "$_test_completed" << 'EOF'
| # | Task | Worker | Started | Completed | Duration |
|---|------|--------|---------|-----------|----------|
| 1 | [FEAT] Add login page | w1 | 2024-01-01 | 2024-01-01 | 5m |
| 2 | [FIX] Fix header styling | w2 | 2024-01-02 | 2024-01-02 | 3m |
EOF

completed_tasks=$(awk -F'|' 'NR>2 {t=$3; gsub(/^ +| +$/,"",t); if(t!="") print "- [ ] " t}' "$_test_completed")
assert_contains "$completed_tasks" "- [ ] [FEAT] Add login page" "extracts first completed task"
assert_contains "$completed_tasks" "- [ ] [FIX] Fix header styling" "extracts second completed task"
# Verify normalization works on extracted completed tasks
norm=$(_normalize_task_line "- [ ] [FEAT] Add login page")
assert_eq "$norm" "add login page" "completed task normalizes correctly"

echo ""
log "=== Dedup snapshot: failed-tasks.md parsing (active statuses only) ==="

# Simulate the awk pattern from project-driver.sh lines 385-399
_test_failed="$TMPDIR_ROOT/test_failed.md"
cat > "$_test_failed" << 'EOF'
| # | Task | Worker | Failed | Attempts | Status |
|---|------|--------|--------|----------|--------|
| 1 | [FIX] Fix crash on startup | w1 | 2024-01-01 | 1 | pending |
| 2 | [FIX] Fix memory leak | w1 | 2024-01-02 | 2 | fixing-1 |
| 3 | [FIX] Fix old bug | w2 | 2024-01-03 | 3 | fixed |
| 4 | [FIX] Fix auth redirect | w1 | 2024-01-04 | 1 | blocked |
| 5 | [FIX] Fix superseded issue | w2 | 2024-01-05 | 1 | superseded |
EOF

failed_active=$(awk -F'|' '
  function trim(v){ gsub(/^ +| +$/,"",v); return v }
  NR>2 {
    t=trim($3); s=trim($7)
    if (t != "" && (s == "pending" || s ~ /^fixing-/ || s == "blocked")) {
      print "- [ ] " t
    }
  }
' "$_test_failed")
assert_contains "$failed_active" "Fix crash on startup" "includes pending failed task"
assert_contains "$failed_active" "Fix memory leak" "includes fixing-N failed task"
assert_contains "$failed_active" "Fix auth redirect" "includes blocked failed task"
assert_not_contains "$failed_active" "Fix old bug" "excludes fixed task"
assert_not_contains "$failed_active" "Fix superseded issue" "excludes superseded task"

# ══════════════════════════════════════════════════════════════════════
# RECONCILIATION TAG/TITLE PARSING
# ══════════════════════════════════════════════════════════════════════
# Tests the sed patterns used in project-driver.sh lines 448-456 to extract
# tag, title, and description from backlog lines.

echo ""
log "=== Reconciliation: tag extraction ==="

# Pattern: sed -n 's/^- \[ \] \[\([^]]*\)\].*/\1/p'
test_line="- [ ] [FEAT] Add user authentication — Implement OAuth2 flow"
tag=$(echo "$test_line" | sed -n 's/^- \[ \] \[\([^]]*\)\].*/\1/p')
assert_eq "$tag" "FEAT" "extracts FEAT tag"

test_line="- [ ] [TEST] Add unit tests"
tag=$(echo "$test_line" | sed -n 's/^- \[ \] \[\([^]]*\)\].*/\1/p')
assert_eq "$tag" "TEST" "extracts TEST tag"

test_line="- [ ] [INFRA] Setup monitoring — Add Grafana dashboards"
tag=$(echo "$test_line" | sed -n 's/^- \[ \] \[\([^]]*\)\].*/\1/p')
assert_eq "$tag" "INFRA" "extracts INFRA tag"

test_line="- [ ] No tag here"
tag=$(echo "$test_line" | sed -n 's/^- \[ \] \[\([^]]*\)\].*/\1/p')
assert_empty "$tag" "returns empty for untagged line"

echo ""
log "=== Reconciliation: title and description extraction ==="

# Pattern: sed 's/^- \[ \] \[[^]]*\] *//' then split on " — "
test_line="- [ ] [FEAT] Add user authentication — Implement OAuth2 flow"
rest=$(echo "$test_line" | sed 's/^- \[ \] \[[^]]*\] *//')
title=$(echo "$rest" | sed 's/ — .*//')
desc=""
case "$rest" in *" — "*) desc=$(echo "$rest" | sed 's/^[^—]*— //') ;; esac
assert_eq "$title" "Add user authentication" "extracts title before em-dash"
assert_eq "$desc" "Implement OAuth2 flow" "extracts description after em-dash"

test_line="- [ ] [FIX] Fix login bug"
rest=$(echo "$test_line" | sed 's/^- \[ \] \[[^]]*\] *//')
title=$(echo "$rest" | sed 's/ — .*//')
desc=""
case "$rest" in *" — "*) desc=$(echo "$rest" | sed 's/^[^—]*— //') ;; esac
assert_eq "$title" "Fix login bug" "extracts title without description"
assert_empty "$desc" "no description when no em-dash"

# ══════════════════════════════════════════════════════════════════════
# FULL-SCRIPT INTEGRATION: POST-AGENT DEDUPLICATION
# ══════════════════════════════════════════════════════════════════════

echo ""
log "=== FULL SCRIPT: normalized duplicates removed, new tasks kept ==="

reset_state

# Create OLD backlog with existing tasks
cat > "$MOCK_DEV_DIR/backlog.md" << 'EOF'
- [ ] [FEAT] Add User Auth
- [x] [FIX] Old completed task
EOF

# Agent output: normalized dupe (different case) + genuinely new task
cat > "$TMPDIR_ROOT/agent_output.md" << 'EOF'
- [ ] [FEAT] add user auth
- [ ] [FIX] Fix New Bug
EOF
export MOCK_AGENT_OUTPUT="$TMPDIR_ROOT/agent_output.md"
export MOCK_DB_ADDED_FILE="$TMPDIR_ROOT/db_added.txt"

run_project_driver

assert_eq "$_rc" "0" "dedup-basic: exit code 0"
assert_contains "$_backlog" "- [ ] [FIX] Fix New Bug" "dedup-basic: new task kept"
assert_not_contains "$_backlog" "add user auth" "dedup-basic: normalized duplicate removed"
assert_contains "$_output" "Skipped duplicate" "dedup-basic: dedup logged"

echo ""
log "=== FULL SCRIPT: completed.md entries prevent duplicates ==="

reset_state

# No old backlog, but completed.md has a task
cat > "$MOCK_DEV_DIR/completed.md" << 'EOF'
| # | Task | Worker | Started | Completed | Duration |
|---|------|--------|---------|-----------|----------|
| 1 | [FEAT] Add login page | w1 | 2024-01-01 | 2024-01-01 | 5m |
EOF

# Agent generates a task that matches a completed one
cat > "$TMPDIR_ROOT/agent_output.md" << 'EOF'
- [ ] [FEAT] Add Login Page
- [ ] [FIX] Fix new issue
EOF
export MOCK_AGENT_OUTPUT="$TMPDIR_ROOT/agent_output.md"
export MOCK_DB_ADDED_FILE="$TMPDIR_ROOT/db_added.txt"

run_project_driver

assert_eq "$_rc" "0" "dedup-completed: exit code 0"
assert_not_contains "$_backlog" "Add Login Page" "dedup-completed: completed task removed from backlog"
assert_contains "$_backlog" "- [ ] [FIX] Fix new issue" "dedup-completed: new task kept"

echo ""
log "=== FULL SCRIPT: active failed tasks prevent duplicates ==="

reset_state

# No old backlog, but failed-tasks.md has an active task
cat > "$MOCK_DEV_DIR/failed-tasks.md" << 'EOF'
| # | Task | Worker | Failed | Attempts | Status |
|---|------|--------|--------|----------|--------|
| 1 | [FIX] Fix crash on startup | w1 | 2024-01-01 | 1 | pending |
EOF

# Agent generates a task matching the active failed entry
cat > "$TMPDIR_ROOT/agent_output.md" << 'EOF'
- [ ] [FIX] Fix Crash On Startup
- [ ] [TEST] Add new tests
EOF
export MOCK_AGENT_OUTPUT="$TMPDIR_ROOT/agent_output.md"
export MOCK_DB_ADDED_FILE="$TMPDIR_ROOT/db_added.txt"

run_project_driver

assert_eq "$_rc" "0" "dedup-failed: exit code 0"
assert_not_contains "$_backlog" "Fix Crash On Startup" "dedup-failed: active failed task removed"
assert_contains "$_backlog" "- [ ] [TEST] Add new tests" "dedup-failed: new task kept"

echo ""
log "=== FULL SCRIPT: non-task lines preserved through dedup ==="

reset_state

# Old backlog with a task that the agent keeps
cat > "$MOCK_DEV_DIR/backlog.md" << 'EOF'
- [ ] [FEAT] Existing task
EOF

# Agent output with headers, blank lines, and non-checkbox lines
cat > "$TMPDIR_ROOT/agent_output.md" << 'EOF'
# Task Backlog

- [ ] [FEAT] Existing task
- [ ] [FIX] Brand new fix

## Completed History
- [x] [FEAT] Old done task
EOF
export MOCK_AGENT_OUTPUT="$TMPDIR_ROOT/agent_output.md"
export MOCK_DB_ADDED_FILE="$TMPDIR_ROOT/db_added.txt"

run_project_driver

assert_eq "$_rc" "0" "preserve-lines: exit code 0"
assert_contains "$_backlog" "# Task Backlog" "preserve-lines: header preserved"
assert_contains "$_backlog" "## Completed History" "preserve-lines: section header preserved"
assert_contains "$_backlog" "- [x] [FEAT] Old done task" "preserve-lines: done task preserved"

echo ""
log "=== FULL SCRIPT: no dedup when snapshot is empty ==="

reset_state

# No old state files at all (fresh project)
# Agent writes a new backlog
cat > "$TMPDIR_ROOT/agent_output.md" << 'EOF'
- [ ] [FEAT] First task ever
- [ ] [FIX] Second task
EOF
export MOCK_AGENT_OUTPUT="$TMPDIR_ROOT/agent_output.md"
export MOCK_DB_ADDED_FILE="$TMPDIR_ROOT/db_added.txt"

run_project_driver

assert_eq "$_rc" "0" "empty-snapshot: exit code 0"
assert_contains "$_backlog" "- [ ] [FEAT] First task ever" "empty-snapshot: first task kept"
assert_contains "$_backlog" "- [ ] [FIX] Second task" "empty-snapshot: second task kept"
assert_not_contains "$_output" "Skipped duplicate" "empty-snapshot: no dedup logged"

# ══════════════════════════════════════════════════════════════════════
# FULL-SCRIPT INTEGRATION: RECONCILIATION TO SQLite
# ══════════════════════════════════════════════════════════════════════

echo ""
log "=== FULL SCRIPT: new tasks reconciled to SQLite ==="

reset_state

# Agent writes backlog with new tagged tasks
cat > "$TMPDIR_ROOT/agent_output.md" << 'EOF'
- [ ] [FEAT] New feature — Implement the thing
- [ ] [TEST] Add tests for auth
EOF
export MOCK_AGENT_OUTPUT="$TMPDIR_ROOT/agent_output.md"
export MOCK_DB_ADDED_FILE="$TMPDIR_ROOT/db_added.txt"

run_project_driver

assert_eq "$_rc" "0" "reconcile-new: exit code 0"
assert_not_empty "$_db_added" "reconcile-new: tasks were added to DB"
assert_contains "$_db_added" "New feature|FEAT|Implement the thing" "reconcile-new: first task with desc"
assert_contains "$_db_added" "Add tests for auth|TEST|" "reconcile-new: second task without desc"
assert_contains "$_output" "Reconciled new task to SQLite" "reconcile-new: reconciliation logged"

echo ""
log "=== FULL SCRIPT: existing DB tasks skipped during reconciliation ==="

reset_state

# Agent writes a task that already exists in the DB
cat > "$TMPDIR_ROOT/agent_output.md" << 'EOF'
- [ ] [FEAT] Already exists
- [ ] [FIX] Brand new fix
EOF
export MOCK_AGENT_OUTPUT="$TMPDIR_ROOT/agent_output.md"
export MOCK_DB_ADDED_FILE="$TMPDIR_ROOT/db_added.txt"
# Mark "Already exists" as existing in DB (checked as "[FEAT] Already exists")
printf '[FEAT] Already exists\n' > "$TMPDIR_ROOT/db_tasks.txt"
export MOCK_DB_TASKS_FILE="$TMPDIR_ROOT/db_tasks.txt"

run_project_driver

assert_eq "$_rc" "0" "reconcile-skip: exit code 0"
assert_not_contains "$_db_added" "Already exists" "reconcile-skip: existing task not re-added"
assert_contains "$_db_added" "Brand new fix|FIX|" "reconcile-skip: new task still added"

echo ""
log "=== FULL SCRIPT: untagged tasks skipped during reconciliation ==="

reset_state

# Agent writes a task without a tag
cat > "$TMPDIR_ROOT/agent_output.md" << 'EOF'
- [ ] No tag on this task
- [ ] [FEAT] Properly tagged task
EOF
export MOCK_AGENT_OUTPUT="$TMPDIR_ROOT/agent_output.md"
export MOCK_DB_ADDED_FILE="$TMPDIR_ROOT/db_added.txt"

run_project_driver

assert_eq "$_rc" "0" "reconcile-notag: exit code 0"
assert_not_contains "$_db_added" "No tag on this task" "reconcile-notag: untagged task skipped"
assert_contains "$_db_added" "Properly tagged task|FEAT|" "reconcile-notag: tagged task added"

# ══════════════════════════════════════════════════════════════════════
# FULL-SCRIPT INTEGRATION: AGENT FAILURE HANDLING
# ══════════════════════════════════════════════════════════════════════

echo ""
log "=== FULL SCRIPT: agent failure skips dedup and reconciliation ==="

reset_state

cat > "$MOCK_DEV_DIR/backlog.md" << 'EOF'
- [ ] [FEAT] Pre-existing task
EOF

export MOCK_AGENT_EXIT_CODE="1"
export MOCK_DB_ADDED_FILE="$TMPDIR_ROOT/db_added.txt"

run_project_driver

assert_eq "$_rc" "0" "agent-fail: script exits 0 (failure handled)"
assert_contains "$_output" "exit" "agent-fail: failure logged"
# Backlog should be unchanged (agent didn't write, no dedup/reconciliation)
assert_contains "$_backlog" "- [ ] [FEAT] Pre-existing task" "agent-fail: backlog unchanged"
assert_empty "$_db_added" "agent-fail: no reconciliation happened"

# ══════════════════════════════════════════════════════════════════════
# FULL-SCRIPT INTEGRATION: DB TITLES IN DEDUP SNAPSHOT
# ══════════════════════════════════════════════════════════════════════

echo ""
log "=== FULL SCRIPT: SQLite titles feed into dedup snapshot ==="

reset_state

# DB has a task title
printf '[FEAT] DB Task Alpha\n' > "$TMPDIR_ROOT/db_titles.txt"
export MOCK_DB_TITLES_FILE="$TMPDIR_ROOT/db_titles.txt"

# Agent generates a task matching the DB title
cat > "$TMPDIR_ROOT/agent_output.md" << 'EOF'
- [ ] [FEAT] db task alpha
- [ ] [FIX] Unique new fix
EOF
export MOCK_AGENT_OUTPUT="$TMPDIR_ROOT/agent_output.md"
export MOCK_DB_ADDED_FILE="$TMPDIR_ROOT/db_added.txt"

run_project_driver

assert_eq "$_rc" "0" "db-dedup: exit code 0"
assert_not_contains "$_backlog" "db task alpha" "db-dedup: DB duplicate removed"
assert_contains "$_backlog" "- [ ] [FIX] Unique new fix" "db-dedup: unique task kept"

# ── Summary ──────────────────────────────────────────────────────────

echo ""
TOTAL=$((PASS + FAIL))
log "Results: $PASS/$TOTAL passed, $FAIL failed"
if [ "$FAIL" -eq 0 ]; then
  printf "  \033[32mAll checks passed!\033[0m\n"
else
  printf "  \033[31mSome checks failed!\033[0m\n"
  exit 1
fi
