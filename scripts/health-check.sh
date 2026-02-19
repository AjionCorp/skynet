#!/usr/bin/env bash
# health-check.sh — Daily typecheck + lint, report issues
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_config.sh"

LOG="$SCRIPTS_DIR/health-check.log"
MAX_FIX_ATTEMPTS="$SKYNET_MAX_FIX_ATTEMPTS"

cd "$PROJECT_DIR"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

# --- Claude Code auth pre-check (with alerting) ---
source "$SCRIPTS_DIR/auth-check.sh"
if ! check_claude_auth; then
  exit 1
fi

log "Starting health check."
tg "🏥 *${SKYNET_PROJECT_NAME^^} HEALTH-CHECK* starting — typecheck + lint"

# --- Typecheck ---
log "Running typecheck..."
attempt=0
typecheck_ok=false

while [ $attempt -lt $MAX_FIX_ATTEMPTS ]; do
  attempt=$((attempt + 1))

  if $SKYNET_TYPECHECK_CMD >> "$LOG" 2>&1; then
    log "Typecheck passed (attempt $attempt)."
    typecheck_ok=true
    break
  else
    log "Typecheck failed (attempt $attempt/$MAX_FIX_ATTEMPTS)."

    if [ $attempt -lt $MAX_FIX_ATTEMPTS ]; then
      log "Asking Claude Code to fix type errors..."
      errors=$($SKYNET_TYPECHECK_CMD 2>&1 | tail -50)
      PROMPT="You are working on the ${SKYNET_PROJECT_NAME} project at $PROJECT_DIR.

The TypeScript typecheck is failing. Here are the errors:

\`\`\`
$errors
\`\`\`

Fix these type errors. Do NOT change the behavior of the code — only fix the types.
After fixing, run '$SKYNET_TYPECHECK_CMD' to verify.
Commit fixes with message 'fix: resolve type errors (auto health-check)'."

      run_agent "$PROMPT" "$LOG" || true
    fi
  fi
done

if ! $typecheck_ok; then
  log "Typecheck still failing after $MAX_FIX_ATTEMPTS attempts. Adding blocker."
  if ! grep -q "typecheck failing" "$BLOCKERS" 2>/dev/null; then
    [ -f "$BLOCKERS" ] && sed_inplace 's/_No active blockers._//' "$BLOCKERS"
    echo "- **$(date '+%Y-%m-%d')**: TypeScript typecheck failing after $MAX_FIX_ATTEMPTS auto-fix attempts. Manual intervention needed." >> "$BLOCKERS"
  fi
fi

# --- Lint (informational, don't block on it) ---
log "Running lint..."
if $SKYNET_LINT_CMD >> "$LOG" 2>&1; then
  log "Lint passed."
else
  log "Lint has warnings/errors (non-blocking)."
fi

# --- Git status check ---
log "Checking git status..."
uncommitted=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
if [ "$uncommitted" -gt 0 ]; then
  log "Warning: $uncommitted uncommitted changes in working tree."
fi

# --- Summary ---
if $typecheck_ok; then
  log "Health check: ALL CLEAR"
  tg "🏥 *${SKYNET_PROJECT_NAME^^} HEALTH*: All clear — typecheck passed, $uncommitted uncommitted files"
else
  log "Health check: ISSUES FOUND (see blockers.md)"
  tg "⚠️ *${SKYNET_PROJECT_NAME^^} HEALTH*: Typecheck failing after $MAX_FIX_ATTEMPTS auto-fix attempts. Needs manual review."
fi

log "Health check finished."
