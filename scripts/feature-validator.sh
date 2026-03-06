#!/usr/bin/env bash
# feature-validator.sh — Deep feature validation: login, load every page, test APIs, check for errors
# Runs comprehensive Playwright tests, analyzes failures, creates fix tasks
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_config.sh"

LOG="$LOG_DIR/feature-validator.log"
BASE_URL="$SKYNET_DEV_SERVER_URL"

if [ -z "${SKYNET_PLAYWRIGHT_DIR:-}" ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: SKYNET_PLAYWRIGHT_DIR is not set" >> "$LOG"
  exit 1
fi
WEB_DIR="$PROJECT_DIR/$SKYNET_PLAYWRIGHT_DIR"

mkdir -p "$(dirname "$LOG")"

cd "$PROJECT_DIR"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

# --- PID lock (shared helper from _locks.sh via _config.sh) ---
LOCKFILE="${SKYNET_LOCK_PREFIX}-feature-validator.lock"

if ! acquire_worker_lock "$LOCKFILE" "$LOG" "FEAT-VALIDATOR"; then
  exit 0
fi
trap 'release_lock_if_owned "$LOCKFILE" "$$" 2>/dev/null || true' EXIT INT TERM

log "Feature validator starting."
tg "🔍 *$SKYNET_PROJECT_NAME_UPPER FEATURE-VALIDATOR* starting — deep page + API tests"

# --- Pre-flight: check if dev server is reachable ---
if ! curl -sf "$BASE_URL" > /dev/null 2>&1; then
  log "Dev server not reachable at $BASE_URL. SKIPPED."
  exit 0
fi

log "Server reachable. Running feature validation tests."

# --- Run feature tests ---
cd "$WEB_DIR"

test_output=""
test_exit=0
test_output=$(npx playwright test "$SKYNET_FEATURE_TEST" --reporter=list 2>&1) || test_exit=$?

log "Feature tests exited with code $test_exit"
log "$test_output"

# Count passed/failed
passed=$(echo "$test_output" | grep -c '✓' || true)
passed=${passed:-0}
failed=$(echo "$test_output" | grep -c '✘\|✗\|FAILED\|failed' || true)
failed=${failed:-0}
total=$((passed + failed))

if [ "$test_exit" -eq 0 ]; then
  log "All feature tests passed ($passed/$total)."
  tg "✅ *$SKYNET_PROJECT_NAME_UPPER FEATURES*: All $total feature tests passed"
  exit 0
fi

# --- Tests failed — analyze and create fix tasks ---
# Auth check: only needed for the AI analysis part (Playwright tests don't need auth)
source "$SCRIPTS_DIR/auth-check.sh"
if ! check_any_auth; then
  log "No agent auth available (Claude/Codex). Skipping failure analysis."
  exit 0
fi

log "Feature tests: $passed passed, $failed failed out of $total."
tg "⚠️ *$SKYNET_PROJECT_NAME_UPPER FEATURES*: $failed/$total tests failed — analyzing"

# Count existing unchecked tasks to avoid overfilling backlog
remaining=$(grep -c '^\- \[ \]' "$BACKLOG" 2>/dev/null || true)
remaining=${remaining:-0}
if [ "$remaining" -ge 15 ]; then
  log "Backlog already has $remaining pending tasks. Skipping task creation, just logging failures."
  exit 0
fi

cd "$PROJECT_DIR"

PROMPT="You are the Feature Validator agent for ${SKYNET_PROJECT_NAME}.

Comprehensive feature tests just ran and some FAILED. Analyze the failures and create fix tasks.

## Test Output
\`\`\`
$test_output
\`\`\`

## Current Backlog
$(cat "$BACKLOG")

## Instructions

1. Read the test output carefully. Identify what broke:
   - Pages that don't load (500 errors, redirects to login, runtime errors)
   - Pages that load but show error states or missing content
   - API endpoints returning wrong data or errors
   - Features that don't work (search, navigation, forms)
   - Detail pages that crash on real data

2. For each genuine failure, investigate the actual code to understand the root cause:
   - Read the page component, API route, and related libs
   - Check for missing Supabase tables, wrong column names, import errors
   - Check for auth/middleware issues causing login redirects

3. Add a task to the backlog at $BACKLOG for each real bug:
   - Use format: \`- [ ] [FIX] Description of what needs fixing\`
   - Be specific: include the URL/endpoint, expected vs actual behavior, root cause
   - Do NOT duplicate tasks already in the backlog
   - Add new tasks near the top (after any existing high-priority items)

4. Do NOT add tasks for tests that passed.
5. Do NOT add more than 5 new tasks per run.
6. If a failure is a test issue (not a real bug), fix the test instead.
7. Write updated files directly — no confirmation needed."

if run_agent "$PROMPT" "$LOG"; then
  log "Feature validator analysis completed."
  new_remaining=$(grep -c '^\- \[ \]' "$BACKLOG" 2>/dev/null || true)
  new_remaining=${new_remaining:-0}
  tg "🔍 *$SKYNET_PROJECT_NAME_UPPER FEATURES*: Analysis done — $new_remaining tasks in backlog"
else
  exit_code=$?
  log "Feature validator analysis exited with code $exit_code."
fi

log "Feature validator finished."
