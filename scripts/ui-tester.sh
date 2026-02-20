#!/usr/bin/env bash
# ui-tester.sh — Run Playwright smoke tests, report failures, add tasks for broken/missing things
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_config.sh"

LOG="$SCRIPTS_DIR/ui-tester.log"
WEB_DIR="$PROJECT_DIR/$SKYNET_PLAYWRIGHT_DIR"
BASE_URL="$SKYNET_DEV_SERVER_URL"

mkdir -p "$(dirname "$LOG")"

cd "$PROJECT_DIR"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

# --- PID lock (mkdir-based atomic lock) ---
LOCKFILE="${SKYNET_LOCK_PREFIX}-ui-tester.lock"

acquire_lock() {
  if mkdir "$LOCKFILE" 2>/dev/null; then
    echo $$ > "$LOCKFILE/pid"
    return 0
  fi
  # Lock exists — check for stale lock (owner PID no longer running)
  if [ -d "$LOCKFILE" ] && [ -f "$LOCKFILE/pid" ]; then
    local lock_pid
    lock_pid=$(cat "$LOCKFILE/pid" 2>/dev/null || echo "")
    if [ -n "$lock_pid" ] && ! kill -0 "$lock_pid" 2>/dev/null; then
      log "Removing stale lock (PID $lock_pid no longer running)."
      rm -rf "$LOCKFILE" 2>/dev/null || true
      if mkdir "$LOCKFILE" 2>/dev/null; then
        echo $$ > "$LOCKFILE/pid"
        return 0
      fi
    fi
  fi
  return 1
}

release_lock() {
  rm -rf "$LOCKFILE" 2>/dev/null || true
}

if ! acquire_lock; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Already running (PID $(cat "$LOCKFILE/pid" 2>/dev/null || echo '?')). Exiting." >> "$LOG"
  exit 0
fi
trap 'release_lock' EXIT

log "UI tester starting."
tg "🧪 *$SKYNET_PROJECT_NAME_UPPER UI-TESTER* starting — running Playwright smoke tests"

# --- Pre-flight: check if dev server is reachable ---
if ! curl -sf "$BASE_URL" > /dev/null 2>&1; then
  log "Dev server not reachable at $BASE_URL. SKIPPED."
  exit 0
fi

log "Server reachable. Running Playwright smoke tests."

# --- Run Playwright tests ---
cd "$WEB_DIR"

test_output=""
test_exit=0
test_output=$(npx playwright test --reporter=list 2>&1) || test_exit=$?

log "Playwright exited with code $test_exit"
log "$test_output"

if [ "$test_exit" -eq 0 ]; then
  log "All smoke tests passed."
  tg "🧪 *$SKYNET_PROJECT_NAME_UPPER TESTS*: All Playwright smoke tests passed"
  # Still check server logs for runtime errors even if tests passed
  if [ -f "$SCRIPTS_DIR/next-dev.log" ]; then
    log "Checking server logs for runtime errors..."
    bash "$SCRIPTS_DIR/check-server-errors.sh" >> "$LOG" 2>&1 || \
      log "Server errors found — written to blockers.md"
  fi
  exit 0
fi

# --- Tests failed — analyze failures and add tasks ---
# Auth check: only needed for the AI analysis part (Playwright tests don't need auth)
source "$SCRIPTS_DIR/auth-check.sh"
if ! check_any_auth; then
  log "No agent auth available (Claude/Codex). Skipping failure analysis."
  exit 0
fi

log "Some tests failed. Asking AI agent to analyze and create tasks."
tg "⚠️ *$SKYNET_PROJECT_NAME_UPPER TESTS*: Some Playwright tests failed — analyzing"

# Count existing unchecked tasks to avoid overfilling backlog
remaining=$(grep -c '^\- \[ \]' "$BACKLOG" 2>/dev/null || true)
remaining=${remaining:-0}
if [ "$remaining" -ge 15 ]; then
  log "Backlog already has $remaining pending tasks. Skipping task creation, just logging failures."
  exit 0
fi

PROMPT="You are the UI Tester agent for ${SKYNET_PROJECT_NAME}.

Playwright smoke tests just ran and some FAILED. Analyze the failures and take action.

## Test Output
\`\`\`
$test_output
\`\`\`

## Current Backlog
$(cat "$BACKLOG")

## Instructions

1. Read the test output carefully. Identify what broke:
   - Pages that don't load (500 errors, missing components)
   - API endpoints that return errors or wrong status codes
   - Sync endpoints that redirect to login (auth middleware issue)
   - Missing pages or routes

2. For each genuine failure, add a task to the backlog at $BACKLOG:
   - Use format: \`- [ ] [FIX] Description of what needs fixing\`
   - Be specific: include the URL/endpoint, expected vs actual behavior
   - Do NOT duplicate tasks already in the backlog
   - Add new tasks near the top (after any existing high-priority items)

3. If a failure indicates a configuration issue (not a code bug), add it to blockers at $BLOCKERS instead.

4. Do NOT add tasks for tests that passed.
5. Do NOT add more than 3 new tasks per run.
6. Write updated files directly — no confirmation needed."

if run_agent "$PROMPT" "$LOG"; then
  log "UI tester analysis completed."
else
  exit_code=$?
  log "UI tester analysis exited with code $exit_code."
fi

log "UI tester finished."
