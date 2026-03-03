#!/usr/bin/env bash
# tests/integration/init-setup-agents-bootstrap.test.sh — Zero-to-autonomy bootstrap regression
#
# Validates the full init → setup-agents → pipeline-ready lifecycle:
#   1. `skynet init --non-interactive` creates correct .dev/ structure
#   2. Config file has valid substitutions (no PLACEHOLDERs)
#   3. State files (backlog, completed, failed-tasks, etc.) are created
#   4. Scripts are installed (copied)
#   5. .gitignore is updated with skynet entries
#   6. `skynet setup-agents --dry-run` generates valid agent configs (launchd)
#   7. `skynet setup-agents --dry-run --cron` generates cron entries
#   8. Generated config is loadable by pipeline bash modules (DB init)
#   9. Pipeline can bootstrap: seed task → claim → echo agent → merge → complete
#  10. Re-init with --force overwrites config
#  11. --from-snapshot restores state files
#
# Requirements: git, sqlite3, bash, node (with npx tsx)
# Usage: bash tests/integration/init-setup-agents-bootstrap.test.sh

# NOTE: -e is intentionally omitted — the test uses its own PASS/FAIL counters
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PASS=0
FAIL=0

# Test output helpers
_tlog()  { printf "  %s\n" "$*"; }
pass() { PASS=$((PASS + 1)); printf "  \033[32m✓\033[0m %s\n" "$*"; }
fail() { FAIL=$((FAIL + 1)); printf "  \033[31m✗\033[0m %s\n" "$*"; }

# log() used by pipeline modules — suppress to avoid noise
log() { :; }

assert_eq() {
  local actual="$1" expected="$2" msg="$3"
  if [ "$actual" = "$expected" ]; then pass "$msg"
  else fail "$msg (expected '$expected', got '$actual')"; fi
}

assert_contains() {
  local haystack="$1" needle="$2" msg="$3"
  if echo "$haystack" | grep -qF "$needle"; then pass "$msg"
  else fail "$msg (expected to contain '$needle')"; fi
}

assert_not_contains() {
  local haystack="$1" needle="$2" msg="$3"
  if echo "$haystack" | grep -qF "$needle"; then fail "$msg (should not contain '$needle')"
  else pass "$msg"; fi
}

assert_not_empty() {
  local val="$1" msg="$2"
  if [ -n "$val" ]; then pass "$msg"
  else fail "$msg (was empty)"; fi
}

assert_file_exists() {
  local path="$1" msg="$2"
  if [ -f "$path" ]; then pass "$msg"
  else fail "$msg (file not found: $path)"; fi
}

assert_dir_exists() {
  local path="$1" msg="$2"
  if [ -d "$path" ]; then pass "$msg"
  else fail "$msg (dir not found: $path)"; fi
}

# ── Setup: create isolated environment ──────────────────────────────

TMPDIR_ROOT=$(mktemp -d)
CLI_SRC="$REPO_ROOT/packages/cli/src/index.ts"
cleanup() {
  rm -rf "/tmp/skynet-test-bootstrap-$$"* 2>/dev/null || true
  rm -rf "$TMPDIR_ROOT"
}
trap cleanup EXIT

echo ""
_tlog "=== Setup: creating isolated git environment for bootstrap test ==="

# Create bare remote and clone as project
git init --bare "$TMPDIR_ROOT/remote.git" >/dev/null 2>&1
git -C "$TMPDIR_ROOT/remote.git" symbolic-ref HEAD refs/heads/main
git clone "$TMPDIR_ROOT/remote.git" "$TMPDIR_ROOT/project" >/dev/null 2>&1

cd "$TMPDIR_ROOT/project"
git checkout -b main 2>/dev/null || true
git config user.email "test@bootstrap.test"
git config user.name "Bootstrap Test"
echo "# Bootstrap Test Project" > README.md
git add README.md
git commit -m "Initial commit" >/dev/null 2>&1
git push -u origin main >/dev/null 2>&1

# ── Test 1: skynet init --non-interactive ─────────────────────────

echo ""
_tlog "=== Test 1: skynet init creates .dev/ structure ==="

INIT_OUTPUT=$(cd "$TMPDIR_ROOT/project" && npx tsx "$CLI_SRC" init \
  --name "test-bootstrap" \
  --non-interactive \
  --copy-scripts \
  --dir "$TMPDIR_ROOT/project" 2>&1)

# Verify .dev/ directory structure
assert_dir_exists "$TMPDIR_ROOT/project/.dev" "init creates .dev/ directory"
assert_dir_exists "$TMPDIR_ROOT/project/.dev/scripts" "init creates .dev/scripts/"
assert_dir_exists "$TMPDIR_ROOT/project/.dev/prompts" "init creates .dev/prompts/"
assert_dir_exists "$TMPDIR_ROOT/project/.dev/skills" "init creates .dev/skills/"

# Verify config files
assert_file_exists "$TMPDIR_ROOT/project/.dev/skynet.config.sh" "init creates skynet.config.sh"
assert_file_exists "$TMPDIR_ROOT/project/.dev/skynet.project.sh" "init creates skynet.project.sh"

# Verify state files
assert_file_exists "$TMPDIR_ROOT/project/.dev/mission.md" "init creates mission.md"
assert_file_exists "$TMPDIR_ROOT/project/.dev/backlog.md" "init creates backlog.md"
assert_file_exists "$TMPDIR_ROOT/project/.dev/completed.md" "init creates completed.md"
assert_file_exists "$TMPDIR_ROOT/project/.dev/failed-tasks.md" "init creates failed-tasks.md"
assert_file_exists "$TMPDIR_ROOT/project/.dev/blockers.md" "init creates blockers.md"

# ── Test 2: Config file substitutions ──────────────────────────────

echo ""
_tlog "=== Test 2: Config file has correct substitutions ==="

CONFIG_CONTENT=$(cat "$TMPDIR_ROOT/project/.dev/skynet.config.sh")
assert_contains "$CONFIG_CONTENT" "test-bootstrap" "config has project name"
assert_contains "$CONFIG_CONTENT" "$TMPDIR_ROOT/project" "config has project dir"
assert_not_contains "$CONFIG_CONTENT" "PLACEHOLDER_PROJECT_NAME" "config has no PLACEHOLDER_PROJECT_NAME"
assert_not_contains "$CONFIG_CONTENT" "PLACEHOLDER_PROJECT_DIR" "config has no PLACEHOLDER_PROJECT_DIR"

# Verify config is valid bash (can be sourced without errors)
PARSE_RC=0
bash -n "$TMPDIR_ROOT/project/.dev/skynet.config.sh" 2>/dev/null || PARSE_RC=$?
assert_eq "$PARSE_RC" "0" "config file is valid bash syntax"

# Source the config to verify variable expansion works in bash
eval "$(grep -v '^#' "$TMPDIR_ROOT/project/.dev/skynet.config.sh" | grep '^export ')"
assert_eq "$SKYNET_PROJECT_NAME" "test-bootstrap" "config exports correct SKYNET_PROJECT_NAME"
assert_eq "$SKYNET_PROJECT_DIR" "$TMPDIR_ROOT/project" "config exports correct SKYNET_PROJECT_DIR"

# ── Test 3: Scripts installed ──────────────────────────────────────

echo ""
_tlog "=== Test 3: Pipeline scripts are installed ==="

assert_file_exists "$TMPDIR_ROOT/project/.dev/scripts/watchdog.sh" "watchdog.sh installed"
assert_file_exists "$TMPDIR_ROOT/project/.dev/scripts/dev-worker.sh" "dev-worker.sh installed"
assert_file_exists "$TMPDIR_ROOT/project/.dev/scripts/_config.sh" "_config.sh installed"

# Count that multiple scripts were installed
SCRIPT_COUNT=$(find "$TMPDIR_ROOT/project/.dev/scripts" -maxdepth 1 -name "*.sh" | wc -l | tr -d ' ')
if [ "$SCRIPT_COUNT" -gt 5 ]; then pass "multiple scripts installed ($SCRIPT_COUNT .sh files)"
else fail "expected >5 scripts, got $SCRIPT_COUNT"; fi

# Agent plugins should also be installed
assert_dir_exists "$TMPDIR_ROOT/project/.dev/scripts/agents" "agents/ directory installed"

# ── Test 4: .gitignore updated ─────────────────────────────────────

echo ""
_tlog "=== Test 4: .gitignore has skynet entries ==="

assert_file_exists "$TMPDIR_ROOT/project/.gitignore" ".gitignore exists"
GITIGNORE=$(cat "$TMPDIR_ROOT/project/.gitignore")
assert_contains "$GITIGNORE" "Skynet pipeline" ".gitignore has skynet section"
assert_contains "$GITIGNORE" ".dev/skynet.config.sh" ".gitignore excludes config"

# ── Test 5: setup-agents --dry-run (launchd) ──────────────────────

echo ""
_tlog "=== Test 5: setup-agents --dry-run generates agent configs ==="

# loadConfig's regex requires quoted values with no trailing content.
# Strip inline comments so the TypeScript config parser can read the file.
sed -i.bak 's/\(["'"'"']\)  *#.*/\1/' "$TMPDIR_ROOT/project/.dev/skynet.config.sh"

DRYRUN_OUTPUT=$(cd "$TMPDIR_ROOT/project" && npx tsx "$CLI_SRC" setup-agents \
  --dry-run \
  --dir "$TMPDIR_ROOT/project" 2>&1)

assert_contains "$DRYRUN_OUTPUT" "dry-run" "setup-agents shows dry-run label"
assert_contains "$DRYRUN_OUTPUT" "test-bootstrap" "setup-agents substitutes project name"
assert_contains "$DRYRUN_OUTPUT" "watchdog" "dry-run includes watchdog agent"
assert_not_contains "$DRYRUN_OUTPUT" "SKYNET_PROJECT_NAME" "dry-run has no unsubstituted SKYNET_PROJECT_NAME"

# ── Test 6: setup-agents --dry-run --cron ──────────────────────────

echo ""
_tlog "=== Test 6: setup-agents --dry-run --cron generates cron entries ==="

CRON_OUTPUT=$(cd "$TMPDIR_ROOT/project" && npx tsx "$CLI_SRC" setup-agents \
  --dry-run \
  --cron \
  --dir "$TMPDIR_ROOT/project" 2>&1)

assert_contains "$CRON_OUTPUT" "dry-run" "cron dry-run shows dry-run label"
assert_contains "$CRON_OUTPUT" "BEGIN skynet:test-bootstrap" "cron has BEGIN marker"
assert_contains "$CRON_OUTPUT" "END skynet:test-bootstrap" "cron has END marker"
assert_contains "$CRON_OUTPUT" "watchdog" "cron includes watchdog schedule"

# ── Test 7: Generated config bootstraps the pipeline ───────────────

echo ""
_tlog "=== Test 7: Pipeline bootstraps from init-generated config ==="

# Set up environment for pipeline modules
export SKYNET_DEV_DIR="$TMPDIR_ROOT/project/.dev"
export SKYNET_PROJECT_DIR="$TMPDIR_ROOT/project"
export SKYNET_PROJECT_NAME="test-bootstrap"
export SKYNET_LOCK_PREFIX="/tmp/skynet-test-bootstrap-$$"
export SKYNET_MAIN_BRANCH="main"
export SKYNET_MAX_WORKERS=2
export SKYNET_MAX_FIXERS=0
export SKYNET_STALE_MINUTES=45
export SKYNET_BRANCH_PREFIX="dev/"
export SKYNET_INSTALL_CMD="true"
export SKYNET_TYPECHECK_CMD="true"
export SKYNET_POST_MERGE_TYPECHECK="false"
export SKYNET_POST_MERGE_SMOKE="false"
export SKYNET_TG_ENABLED="false"
export SKYNET_NOTIFY_CHANNELS=""
export SKYNET_DEV_PORT=13500
export SKYNET_AGENT_TIMEOUT_MINUTES=5
export SKYNET_LOCK_BACKEND="file"
export SKYNET_USE_FLOCK="true"
export SKYNET_AGENT_PLUGIN="echo"
export SKYNET_MAX_TASKS_PER_RUN=1
export SKYNET_MAX_LOG_SIZE_KB=1024
export SKYNET_MAX_EVENTS_LOG_KB=1024

# Derived paths
PROJECT_DIR="$SKYNET_PROJECT_DIR"
DEV_DIR="$SKYNET_DEV_DIR"
SCRIPTS_DIR="$SKYNET_DEV_DIR/scripts"
BACKLOG="$DEV_DIR/backlog.md"
COMPLETED="$DEV_DIR/completed.md"
FAILED="$DEV_DIR/failed-tasks.md"
BLOCKERS="$DEV_DIR/blockers.md"

# Source pipeline modules (use REPO_ROOT scripts for correct module resolution)
SKYNET_SCRIPTS_DIR="$REPO_ROOT/scripts"
source "$REPO_ROOT/scripts/_compat.sh"
source "$REPO_ROOT/scripts/_notify.sh"

# Stub db_add_event before sourcing _events.sh
db_add_event() { :; }
source "$REPO_ROOT/scripts/_events.sh"

# Source lock backend and locks
source "$REPO_ROOT/scripts/_lock_backend.sh"
source "$REPO_ROOT/scripts/_locks.sh"

# Source DB layer and merge helper
source "$REPO_ROOT/scripts/_db.sh"
source "$REPO_ROOT/scripts/_merge.sh"

# Source echo agent plugin
source "$REPO_ROOT/scripts/agents/echo.sh"

# Unset the stub and re-source events now that db is available
unset -f db_add_event 2>/dev/null || true
source "$REPO_ROOT/scripts/_events.sh"

# Log file
LOG="$TMPDIR_ROOT/test-bootstrap.log"
: > "$LOG"
log() { echo "[$(date '+%H:%M:%S')] $*" >> "$LOG"; }

# Stub notification helpers
tg() { :; }
emit_event() { :; }

# Initialize the database
DB_PATH="$DEV_DIR/skynet.db"
db_init >/dev/null 2>&1
assert_file_exists "$DB_PATH" "db_init creates skynet.db from init-generated config"

# Verify DB has the tasks table
TABLE_EXISTS=$(sqlite3 "$DB_PATH" "SELECT name FROM sqlite_master WHERE type='table' AND name='tasks';" 2>/dev/null)
assert_eq "$TABLE_EXISTS" "tasks" "database has tasks table"

# ── Test 8: Full echo agent lifecycle from init'd project ──────────

echo ""
_tlog "=== Test 8: Echo agent lifecycle in bootstrapped project ==="

# Add a task via the DB API (same as CLI add-task)
TASK_ID=$(db_add_task "[TEST] Bootstrap hello world task" "TEST")
assert_not_empty "$TASK_ID" "db_add_task returns task ID"

PENDING_COUNT=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM tasks WHERE status='pending';")
assert_eq "$PENDING_COUNT" "1" "seeded task registered in DB"

# Claim the task
SEP=$'\x1f'
WORKER_ID=1
TASK_INFO=$(db_claim_next_task "$WORKER_ID")
assert_not_empty "$TASK_INFO" "task claimed successfully"

TASK_CLAIMED_ID=$(echo "$TASK_INFO" | awk -F"$SEP" '{print $1}')
TASK_TITLE=$(echo "$TASK_INFO" | awk -F"$SEP" '{print $2}')
assert_contains "$TASK_TITLE" "Bootstrap hello world" "claimed task has correct title"

# Create a worktree and run echo agent
cd "$TMPDIR_ROOT/project"
SKYNET_WORKTREE_BASE="$TMPDIR_ROOT/worktrees"
mkdir -p "$SKYNET_WORKTREE_BASE"
BRANCH_NAME="dev/bootstrap-hello-world-task"
WORKTREE_DIR="$SKYNET_WORKTREE_BASE/w-bootstrap"
git worktree add "$WORKTREE_DIR" -b "$BRANCH_NAME" main >/dev/null 2>&1

# Run echo agent inside the worktree (subshell to isolate cd)
(
  cd "$WORKTREE_DIR"
  git config user.email "test@bootstrap.test"
  git config user.name "Bootstrap Test"
  agent_run "$TASK_TITLE" "$LOG"
)
AGENT_RC=$?
assert_eq "$AGENT_RC" "0" "echo agent completes successfully"

# Verify echo agent created a placeholder file
ECHO_FILE=$(find "$WORKTREE_DIR" -name "echo-agent-*.md" -not -path "*/.git/*" 2>/dev/null | head -1)
assert_not_empty "$ECHO_FILE" "echo agent created placeholder file"

# Merge the worktree branch back to main
cd "$TMPDIR_ROOT/project"
git checkout main >/dev/null 2>&1
git merge "$BRANCH_NAME" --no-edit >/dev/null 2>&1
MERGE_RC=$?
assert_eq "$MERGE_RC" "0" "merge to main succeeds"

# Clean up worktree
git worktree remove "$WORKTREE_DIR" --force 2>/dev/null || true
git worktree prune 2>/dev/null || true

# Verify merged file exists on main
MAIN_ECHO=$(find . -name "echo-agent-*.md" -not -path "./.git/*" 2>/dev/null | head -1)
assert_not_empty "$MAIN_ECHO" "echo placeholder present on main after merge"

# Mark task complete
db_complete_task "$TASK_CLAIMED_ID" "$BRANCH_NAME" "0m10s" 10 "test-success"
TASK_STATUS=$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id=$TASK_CLAIMED_ID;")
assert_eq "$TASK_STATUS" "completed" "task marked completed after merge"

# Push the merged result
git push origin main >/dev/null 2>&1

# ── Test 9: Re-init with --force overwrites config ─────────────────

echo ""
_tlog "=== Test 9: Re-init with --force overwrites config ==="

REINIT_OUTPUT=$(cd "$TMPDIR_ROOT/project" && npx tsx "$CLI_SRC" init \
  --name "test-reinit" \
  --non-interactive \
  --force \
  --dir "$TMPDIR_ROOT/project" 2>&1)

NEW_CONFIG=$(cat "$TMPDIR_ROOT/project/.dev/skynet.config.sh")
assert_contains "$NEW_CONFIG" "test-reinit" "re-init with --force updates project name"

# State files should still exist (init doesn't overwrite existing state files)
assert_file_exists "$TMPDIR_ROOT/project/.dev/backlog.md" "re-init preserves backlog.md"
assert_file_exists "$TMPDIR_ROOT/project/.dev/mission.md" "re-init preserves mission.md"

# ── Test 10: --from-snapshot restores state ─────────────────────────

echo ""
_tlog "=== Test 10: Init from snapshot restores state ==="

# Create a snapshot file
SNAPSHOT_PATH="$TMPDIR_ROOT/snapshot.json"
cat > "$SNAPSHOT_PATH" <<'SNAPSHOT'
{
  "backlog.md": "# Backlog\n\n- [ ] [FEAT] Snapshot task alpha\n- [ ] [FIX] Snapshot task beta\n",
  "completed.md": "# Completed\n\n- [x] [FEAT] Previously done task\n",
  "failed-tasks.md": "# Failed Tasks\n",
  "blockers.md": "# Blockers\n",
  "mission.md": "# Mission\n\n## Purpose\n\nTest snapshot restore\n"
}
SNAPSHOT

# Create a fresh project for snapshot test
git init --bare "$TMPDIR_ROOT/snap-remote.git" >/dev/null 2>&1
git -C "$TMPDIR_ROOT/snap-remote.git" symbolic-ref HEAD refs/heads/main
git clone "$TMPDIR_ROOT/snap-remote.git" "$TMPDIR_ROOT/snap-project" >/dev/null 2>&1
cd "$TMPDIR_ROOT/snap-project"
git checkout -b main 2>/dev/null || true
git config user.email "test@snapshot.test"
git config user.name "Snapshot Test"
echo "# Snapshot Test" > README.md
git add README.md
git commit -m "Initial commit" >/dev/null 2>&1
git push -u origin main >/dev/null 2>&1

SNAP_OUTPUT=$(cd "$TMPDIR_ROOT/snap-project" && npx tsx "$CLI_SRC" init \
  --name "test-snapshot" \
  --non-interactive \
  --from-snapshot "$SNAPSHOT_PATH" \
  --dir "$TMPDIR_ROOT/snap-project" 2>&1)

assert_contains "$SNAP_OUTPUT" "Restored" "snapshot restore reports success"

# Verify restored content
SNAP_BACKLOG=$(cat "$TMPDIR_ROOT/snap-project/.dev/backlog.md")
assert_contains "$SNAP_BACKLOG" "Snapshot task alpha" "snapshot restored backlog content"

SNAP_COMPLETED=$(cat "$TMPDIR_ROOT/snap-project/.dev/completed.md")
assert_contains "$SNAP_COMPLETED" "Previously done task" "snapshot restored completed content"

SNAP_MISSION=$(cat "$TMPDIR_ROOT/snap-project/.dev/mission.md")
assert_contains "$SNAP_MISSION" "Test snapshot restore" "snapshot restored mission content"

# ── Summary ──────────────────────────────────────────────────────

echo ""
TOTAL=$((PASS + FAIL))
_tlog "Results: $PASS/$TOTAL passed, $FAIL failed"
if [ $FAIL -eq 0 ]; then
  printf "  \033[32mAll checks passed!\033[0m\n"
else
  printf "  \033[31mSome checks failed!\033[0m\n"
  exit 1
fi
