#!/usr/bin/env bash
# tests/e2e/init-smoke.test.sh — End-to-end smoke test for `npx skynet init`
#
# Usage: bash tests/e2e/init-smoke.test.sh
# Verifies the full init flow: pack → install → init → verify output.

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
assert_link() { [[ -L "$1" ]] && pass "$2" || fail "$2"; }
assert_grep() { grep -q "$1" "$2" && pass "$3" || fail "$3"; }

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

# ── Step 4: Run skynet init non-interactively ───────────────────────
# Redirect stdin from /dev/null — the init command detects non-TTY stdin
# and uses default values for all prompts automatically.

log "Running: npx skynet init --name test-project"
(cd "$PROJECT_DIR" && npx skynet init --name test-project < /dev/null 2>&1)

# ── Step 5: Verify .dev/ directory and expected files ───────────────

echo ""
log "Verifying output..."

DEV="$PROJECT_DIR/.dev"

assert_dir  "$DEV"                      ".dev/ directory created"
assert_file "$DEV/skynet.config.sh"     ".dev/skynet.config.sh exists"
assert_file "$DEV/skynet.project.sh"    ".dev/skynet.project.sh exists"
assert_dir  "$DEV/prompts"              ".dev/prompts/ directory created"

# Markdown state files
for f in mission.md backlog.md current-task.md completed.md \
         failed-tasks.md blockers.md sync-health.md pipeline-status.md README.md; do
  assert_file "$DEV/$f" ".dev/$f exists"
done

# Config content validation
assert_grep "test-project" "$DEV/skynet.config.sh" "skynet.config.sh contains project name"

# ── Step 6: Verify scripts symlinked correctly ──────────────────────

SCRIPTS="$DEV/scripts"
assert_dir "$SCRIPTS" ".dev/scripts/ directory created"

# Key scripts exist and are symlinks
for f in _config.sh dev-worker.sh watchdog.sh health-check.sh sync-runner.sh; do
  assert_link "$SCRIPTS/$f" ".dev/scripts/$f is symlinked"
done

# Subdirectories are symlinks
for d in agents notify; do
  assert_link "$SCRIPTS/$d" ".dev/scripts/$d/ is symlinked"
done

# .gitignore updated
assert_file "$PROJECT_DIR/.gitignore"                        ".gitignore exists"
assert_grep "skynet.config.sh" "$PROJECT_DIR/.gitignore"     ".gitignore contains skynet entry"

# ── Step 7: Summary (cleanup via EXIT trap) ─────────────────────────

echo ""
TOTAL=$((PASS + FAIL))
log "Results: $PASS/$TOTAL passed, $FAIL failed"
if [[ $FAIL -eq 0 ]]; then
  printf "  \033[32mAll checks passed!\033[0m\n"
else
  printf "  \033[31mSome checks failed!\033[0m\n"
  exit 1
fi
