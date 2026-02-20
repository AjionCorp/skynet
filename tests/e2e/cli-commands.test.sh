#!/usr/bin/env bash
# tests/e2e/cli-commands.test.sh — End-to-end test for full CLI command integration
#
# Usage: bash tests/e2e/cli-commands.test.sh
# Verifies: init, add-task, status, doctor, reset-task, version,
#           export/import round-trip, doctor --fix, config set/get,
#           stop, pause/resume, completions, validate

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PASS=0
FAIL=0
CLEANUP=()

cleanup() {
  for path in "${CLEANUP[@]}"; do
    rm -rf "$path"
  done
}
trap cleanup EXIT

log()  { printf "  %s\n" "$*"; }
pass() { PASS=$((PASS + 1)); printf "  \033[32m✓\033[0m %s\n" "$*"; }
fail() { FAIL=$((FAIL + 1)); printf "  \033[31m✗\033[0m %s\n" "$*"; }

assert_dir()  { [[ -d "$1" ]] && pass "$2" || fail "$2"; }
assert_file() { [[ -f "$1" ]] && pass "$2" || fail "$2"; }
assert_grep() { grep -q "$1" "$2" && pass "$3" || fail "$3"; }
assert_output_grep() {
  # $1 = pattern, $2 = captured output, $3 = description
  echo "$2" | grep -q "$1" && pass "$3" || fail "$3"
}
assert_not_grep() {
  # $1 = pattern, $2 = file, $3 = description — PASS when pattern is absent
  grep -q "$1" "$2" && fail "$3" || pass "$3"
}

# ── Step 1: Build and pack the CLI ──────────────────────────────────

log "Building CLI..."
(cd "$REPO_ROOT/packages/cli" && npx tsc 2>&1)

log "Packing CLI tarball..."
TARBALL_NAME=$(cd "$REPO_ROOT/packages/cli" && npm pack 2>/dev/null | tail -1)
TARBALL="$REPO_ROOT/packages/cli/$TARBALL_NAME"
CLEANUP+=("$TARBALL")

if [[ ! -f "$TARBALL" ]]; then
  log "FATAL: npm pack failed — tarball not found at $TARBALL"
  exit 2
fi
log "Tarball: $TARBALL_NAME"

# ── Step 2: Create temp directory with git repo ─────────────────────

PROJECT_DIR=$(mktemp -d)
CLEANUP+=("$PROJECT_DIR")
(cd "$PROJECT_DIR" && git init -q && git commit --allow-empty -m "init" -q)
log "Temp project: $PROJECT_DIR"

# ── Step 3: Install the tarball via npm ─────────────────────────────

log "Installing CLI from tarball..."
(cd "$PROJECT_DIR" && npm init -y >/dev/null 2>&1 && npm install "$TARBALL" >/dev/null 2>&1)

# ── Test 1: skynet init ─────────────────────────────────────────────

echo ""
log "Test 1: skynet init --name test-project --dir ."

INIT_OUTPUT=$(cd "$PROJECT_DIR" && npx skynet init --name test-project --dir . < /dev/null 2>&1) || true

DEV="$PROJECT_DIR/.dev"

assert_dir  "$DEV"                      "init: .dev/ directory created"
assert_file "$DEV/skynet.config.sh"     "init: .dev/skynet.config.sh exists"
assert_file "$DEV/skynet.project.sh"    "init: .dev/skynet.project.sh exists"
assert_dir  "$DEV/prompts"              "init: .dev/prompts/ directory created"
assert_file "$DEV/mission.md"           "init: .dev/mission.md exists"
assert_file "$DEV/backlog.md"           "init: .dev/backlog.md exists"
assert_file "$DEV/completed.md"         "init: .dev/completed.md exists"
assert_file "$DEV/failed-tasks.md"      "init: .dev/failed-tasks.md exists"
assert_file "$DEV/current-task.md"      "init: .dev/current-task.md exists"
assert_file "$DEV/blockers.md"          "init: .dev/blockers.md exists"
assert_grep "test-project" "$DEV/skynet.config.sh" "init: config contains project name"

# ── Test 2: skynet add-task ─────────────────────────────────────────

echo ""
log "Test 2: skynet add-task \"Test task\" --tag TEST --description \"e2e test\""

ADD_OUTPUT=$(cd "$PROJECT_DIR" && npx skynet add-task "Test task" --tag TEST --description "e2e test" --dir . 2>&1) || true

assert_grep '\[TEST\] Test task' "$DEV/backlog.md" "add-task: task appears in backlog.md"
assert_grep 'e2e test' "$DEV/backlog.md"           "add-task: description appears in backlog.md"
assert_output_grep "Added task to backlog" "$ADD_OUTPUT" "add-task: output confirms task added"

# ── Test 3: skynet status ───────────────────────────────────────────

echo ""
log "Test 3: skynet status --dir ."

STATUS_OUTPUT=$(cd "$PROJECT_DIR" && npx skynet status --dir . 2>&1) || true

assert_output_grep "Skynet Pipeline Status (test-project)" "$STATUS_OUTPUT" "status: shows project name"
assert_output_grep "Pending:.*1"  "$STATUS_OUTPUT" "status: shows 1 pending task"
assert_output_grep "Health Score" "$STATUS_OUTPUT" "status: shows health score"

# ── Test 4: skynet doctor ───────────────────────────────────────────

echo ""
log "Test 4: skynet doctor --dir ."

DOCTOR_OUTPUT=$(cd "$PROJECT_DIR" && npx skynet doctor --dir . 2>&1) || true
DOCTOR_EXIT=$?

assert_output_grep '\[PASS\].*Required Tools' "$DOCTOR_OUTPUT" "doctor: PASS for Required Tools"
assert_output_grep '\[PASS\].*Config'          "$DOCTOR_OUTPUT" "doctor: PASS for Config"
assert_output_grep '\[PASS\].*State Files'     "$DOCTOR_OUTPUT" "doctor: PASS for State Files"
assert_output_grep 'Skynet Doctor'             "$DOCTOR_OUTPUT" "doctor: shows header"

# ── Test 5: skynet reset-task ───────────────────────────────────────

echo ""
log "Test 5: skynet reset-task \"Test task\""

# Manually add a failed-tasks.md entry for "Test task"
cat >> "$DEV/failed-tasks.md" <<'ENTRY'
| 2026-02-19 | Test task | dev/test-task | build failed | 2 | pending |
ENTRY

# Mark the task as done in backlog.md so reset can uncheck it
sed -i.bak 's/- \[ \] \[TEST\] Test task/- [x] [TEST] Test task/' "$DEV/backlog.md"
rm -f "$DEV/backlog.md.bak"

RESET_OUTPUT=$(cd "$PROJECT_DIR" && npx skynet reset-task "Test task" --dir . --force < /dev/null 2>&1) || true

assert_output_grep "Found failed task"    "$RESET_OUTPUT" "reset-task: found the failed task"
assert_output_grep "Task reset complete"  "$RESET_OUTPUT" "reset-task: completed successfully"

# Verify the failed-tasks.md entry was reset to pending with 0 attempts
assert_grep '| 0 | pending |' "$DEV/failed-tasks.md" "reset-task: attempts reset to 0 in failed-tasks.md"

# Verify backlog.md entry was unchecked
assert_grep '\- \[ \] \[TEST\] Test task' "$DEV/backlog.md" "reset-task: backlog entry unchecked"

# ── Test 6: skynet version ──────────────────────────────────────────

echo ""
log "Test 6: skynet version"

VERSION_OUTPUT=$(cd "$PROJECT_DIR" && npx skynet version 2>&1) || true

# Read the expected version from the CLI package.json
CLI_VERSION=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$REPO_ROOT/packages/cli/package.json','utf8')).version)")

assert_output_grep "skynet-cli v${CLI_VERSION}" "$VERSION_OUTPUT" "version: output matches package.json version"
assert_output_grep "skynet-cli v"               "$VERSION_OUTPUT" "version: shows version prefix"

# ── Test 7: skynet export / import round-trip ─────────────────────

echo ""
log "Test 7: skynet export / import round-trip"

EXPORT_FILE="/tmp/skynet-test-export.json"
CLEANUP+=("$EXPORT_FILE")

EXPORT_OUTPUT=$(cd "$PROJECT_DIR" && npx skynet export --output "$EXPORT_FILE" --dir . 2>&1) || true

assert_file "$EXPORT_FILE" "export: JSON snapshot file created"

# Verify JSON contains expected keys
KEYS_OK=$(node -e "
  var d = JSON.parse(require('fs').readFileSync('$EXPORT_FILE','utf8'));
  var keys = ['backlog.md','completed.md','failed-tasks.md','blockers.md','mission.md','skynet.config.sh'];
  console.log(keys.every(function(k){ return k in d; }) ? 'OK' : 'MISSING');
") || true
[[ "$KEYS_OK" == "OK" ]] && pass "export: JSON contains all expected keys" || fail "export: JSON contains all expected keys"

assert_output_grep 'exported to' "$EXPORT_OUTPUT" "export: output confirms export path"

# Modify backlog.md — inject a marker line
echo "- [ ] [TEST] Injected line for round-trip test" >> "$DEV/backlog.md"
assert_grep 'Injected line for round-trip test' "$DEV/backlog.md" "export/import: backlog modification applied"

# Import the snapshot (should overwrite backlog to pre-modification state)
IMPORT_OUTPUT=$(cd "$PROJECT_DIR" && npx skynet import "$EXPORT_FILE" --dir . --force 2>&1) || true

assert_output_grep 'Imported' "$IMPORT_OUTPUT" "import: output confirms import"
assert_not_grep 'Injected line for round-trip test' "$DEV/backlog.md" "import: backlog restored to pre-modification state"

# ── Test 8: skynet doctor --fix (stale heartbeat) ────────────────

echo ""
log "Test 8: skynet doctor --fix (stale heartbeat)"

# Create stale heartbeat file with epoch 0 (worker-1 is within default scan range)
echo "0" > "$DEV/worker-1.heartbeat"

DOCTOR_STALE1=$(cd "$PROJECT_DIR" && npx skynet doctor --dir . 2>&1) || true
assert_output_grep '\[WARN\].*Stale Heartbeats' "$DOCTOR_STALE1" "doctor: WARN for stale heartbeat"

# Run --fix and verify stale heartbeat deleted
DOCTOR_FIX=$(cd "$PROJECT_DIR" && npx skynet doctor --fix --dir . 2>&1) || true
[[ ! -f "$DEV/worker-1.heartbeat" ]] && pass "doctor --fix: stale heartbeat file deleted" || fail "doctor --fix: stale heartbeat file deleted"

# Re-run doctor — heartbeats should now PASS
DOCTOR_STALE2=$(cd "$PROJECT_DIR" && npx skynet doctor --dir . 2>&1) || true
assert_output_grep '\[PASS\].*Stale Heartbeats' "$DOCTOR_STALE2" "doctor: PASS after fix"

# ── Test 9: skynet config set/get round-trip ─────────────────────

echo ""
log "Test 9: skynet config set/get round-trip"

# Read original value
ORIG_MAX=$(cd "$PROJECT_DIR" && npx skynet config --dir . get SKYNET_MAX_WORKERS 2>&1) || true

# Set to 6
SET_OUTPUT=$(cd "$PROJECT_DIR" && npx skynet config --dir . set SKYNET_MAX_WORKERS 6 2>&1) || true
assert_output_grep 'Updated' "$SET_OUTPUT" "config set: confirms update"

# Get and verify
NEW_MAX=$(cd "$PROJECT_DIR" && npx skynet config --dir . get SKYNET_MAX_WORKERS 2>&1) || true
[[ "$(echo "$NEW_MAX" | tr -d '[:space:]')" == "6" ]] && pass "config get: returns 6" || fail "config get: returns 6 (got: $NEW_MAX)"

# Restore original value
cd "$PROJECT_DIR" && npx skynet config --dir . set SKYNET_MAX_WORKERS "$ORIG_MAX" >/dev/null 2>&1 || true
RESTORED=$(cd "$PROJECT_DIR" && npx skynet config --dir . get SKYNET_MAX_WORKERS 2>&1) || true
[[ "$(echo "$RESTORED" | tr -d '[:space:]')" == "$(echo "$ORIG_MAX" | tr -d '[:space:]')" ]] && pass "config set: original value restored" || fail "config set: original value restored"

# ── Test 10: skynet stop (stale lock cleanup) ─────────────────────

echo ""
log "Test 10: skynet stop (stale lock cleanup)"

# Create a mock PID lock directory for dev-worker-3
# The stop command reads lockPrefix from config: /tmp/skynet-test-project
LOCK_DIR="/tmp/skynet-test-project-dev-worker-3.lock"
mkdir -p "$LOCK_DIR"
CLEANUP+=("$LOCK_DIR")

# Write a fake PID (99999 — unlikely to be running) so stop tries to kill it
echo "99999" > "$LOCK_DIR/pid"

STOP_OUTPUT=$(cd "$PROJECT_DIR" && npx skynet stop --dir . 2>&1) || true

# Verify stop recognized the project name
assert_output_grep "Stopping Skynet pipeline for: test-project" "$STOP_OUTPUT" "stop: shows project name"

# Verify stop attempted to clean/stop dev-worker-3 (stale lock since PID 99999 is not running)
assert_output_grep "dev-worker-3" "$STOP_OUTPUT" "stop: found dev-worker-3 lock"

# Verify the lock directory was removed
[[ ! -d "$LOCK_DIR" ]] && pass "stop: lock directory removed after stop" || fail "stop: lock directory removed after stop"

# Verify the output reports either cleaned or stopped
assert_output_grep "stale locks cleaned\|workers stopped" "$STOP_OUTPUT" "stop: reports cleanup result"

# ── Test 11: skynet pause / resume ────────────────────────────────

echo ""
log "Test 11: skynet pause / resume"

PAUSE_FILE="$DEV/pipeline-paused"

# Ensure no leftover pause file
rm -f "$PAUSE_FILE"

# Run pause
PAUSE_OUTPUT=$(cd "$PROJECT_DIR" && npx skynet pause --dir . 2>&1) || true

assert_output_grep "Pipeline paused" "$PAUSE_OUTPUT" "pause: confirms pipeline paused"
assert_file "$PAUSE_FILE" "pause: pipeline-paused sentinel created"

# Verify the sentinel contains valid JSON with pausedAt and pausedBy
PAUSE_JSON_OK=$(node -e "
  var d = JSON.parse(require('fs').readFileSync('$PAUSE_FILE','utf8'));
  console.log(d.pausedAt && d.pausedBy ? 'OK' : 'MISSING');
") || true
[[ "$PAUSE_JSON_OK" == "OK" ]] && pass "pause: sentinel JSON has pausedAt and pausedBy" || fail "pause: sentinel JSON has pausedAt and pausedBy"

# Run pause again — should be idempotent
PAUSE2_OUTPUT=$(cd "$PROJECT_DIR" && npx skynet pause --dir . 2>&1) || true
assert_output_grep "already paused" "$PAUSE2_OUTPUT" "pause: idempotent — says already paused"

# Run resume
RESUME_OUTPUT=$(cd "$PROJECT_DIR" && npx skynet resume --dir . 2>&1) || true

assert_output_grep "Pipeline resumed" "$RESUME_OUTPUT" "resume: confirms pipeline resumed"
[[ ! -f "$PAUSE_FILE" ]] && pass "resume: pipeline-paused sentinel removed" || fail "resume: pipeline-paused sentinel removed"

# Run resume again — should be idempotent
RESUME2_OUTPUT=$(cd "$PROJECT_DIR" && npx skynet resume --dir . 2>&1) || true
assert_output_grep "not paused" "$RESUME2_OUTPUT" "resume: idempotent — says not paused"

# ── Test 12: skynet completions bash ──────────────────────────────

echo ""
log "Test 12: skynet completions bash"

COMP_OUTPUT=$(cd "$PROJECT_DIR" && npx skynet completions bash 2>&1) || true

# Verify output contains the completion function registration
assert_output_grep "complete -F _skynet skynet" "$COMP_OUTPUT" "completions: registers bash completion function"

# Verify output contains compgen -W with command names
assert_output_grep "compgen -W" "$COMP_OUTPUT" "completions: uses compgen -W for command list"

# Verify key command names are present in the output
for cmd in init stop start pause resume status doctor logs version add-task run dashboard reset-task cleanup watch upgrade metrics export import config completions setup-agents test-notify; do
  assert_output_grep "$cmd" "$COMP_OUTPUT" "completions: includes command '$cmd'"
done

# ── Test 13: skynet validate ──────────────────────────────────────

echo ""
log "Test 13: skynet validate"

# validate checks: gates, git remote, disk space, mission.md
# Git remote will fail since temp project has no remote — that's expected
VALIDATE_OUTPUT=$(cd "$PROJECT_DIR" && npx skynet validate --dir . 2>&1) || true

# Verify validate header
assert_output_grep "Skynet Validate" "$VALIDATE_OUTPUT" "validate: shows header"

# Verify it checks quality gates section
assert_output_grep "Quality Gates" "$VALIDATE_OUTPUT" "validate: checks quality gates"

# Verify it checks git remote section
assert_output_grep "Git Remote" "$VALIDATE_OUTPUT" "validate: checks git remote"

# Verify it checks disk space section
assert_output_grep "Disk Space" "$VALIDATE_OUTPUT" "validate: checks disk space"

# Verify it checks mission file section
assert_output_grep "Mission File" "$VALIDATE_OUTPUT" "validate: checks mission file"

# Verify summary section
assert_output_grep "pre-flight checks passed" "$VALIDATE_OUTPUT" "validate: shows summary"

# ── Summary ─────────────────────────────────────────────────────────

echo ""
TOTAL=$((PASS + FAIL))
log "Results: $PASS/$TOTAL passed, $FAIL failed"
if [[ $FAIL -eq 0 ]]; then
  printf "  \033[32mAll checks passed!\033[0m\n"
else
  printf "  \033[31mSome checks failed!\033[0m\n"
  exit 1
fi
