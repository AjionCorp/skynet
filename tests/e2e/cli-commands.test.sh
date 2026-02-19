#!/usr/bin/env bash
# tests/e2e/cli-commands.test.sh — End-to-end test for full CLI command integration
#
# Usage: bash tests/e2e/cli-commands.test.sh
# Verifies: init, add-task, status, doctor, reset-task, version

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
