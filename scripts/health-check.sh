#!/usr/bin/env bash
# health-check.sh — Daily typecheck + lint, report issues
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_config.sh"

LOG="$LOG_DIR/health-check.log"
MAX_FIX_ATTEMPTS="$SKYNET_MAX_FIX_ATTEMPTS"

cd "$PROJECT_DIR"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

# --- PID lock (prevent concurrent health-check runs) ---
# Uses acquire_worker_lock from _locks.sh (sourced via _config.sh)
LOCK_FILE="${SKYNET_LOCK_PREFIX}-health-check.lock"

if ! acquire_worker_lock "$LOCK_FILE" "$LOG" "HC"; then
  exit 0
fi
trap 'release_lock_if_owned "$LOCK_FILE" "$$" 2>/dev/null || true' EXIT INT TERM

# --- Claude Code auth pre-check (with alerting) ---
source "$SCRIPTS_DIR/auth-check.sh"
if ! check_any_auth; then
  log "No agent auth available (Claude/Codex). Skipping health-check."
  exit 1
fi

log "Starting health check."
tg "🏥 *$SKYNET_PROJECT_NAME_UPPER HEALTH-CHECK* starting — typecheck + lint"

# --- Typecheck ---
log "Running typecheck..."
attempt=0
typecheck_ok=false

while [ "$attempt" -lt "$MAX_FIX_ATTEMPTS" ]; do
  attempt=$((attempt + 1))

  # Validate typecheck command against disallowed characters (defense-in-depth)
  case "$SKYNET_TYPECHECK_CMD" in *";"*|*"|"*|*'$('*|*'`'*) log "ERROR: SKYNET_TYPECHECK_CMD contains unsafe characters"; break ;; esac

  if eval "$SKYNET_TYPECHECK_CMD" >> "$LOG" 2>&1; then
    log "Typecheck passed (attempt $attempt)."
    typecheck_ok=true
    break
  else
    log "Typecheck failed (attempt $attempt/$MAX_FIX_ATTEMPTS)."

    if [ "$attempt" -lt "$MAX_FIX_ATTEMPTS" ]; then
      log "Skipping auto-fix: health-check runs in the shared checkout, so agent edits here can race with normal worker merges."
      break
    fi
  fi
done

if ! $typecheck_ok; then
  log "Typecheck still failing after $MAX_FIX_ATTEMPTS attempts. Adding blocker."
  if ! grep -q "typecheck failing" "$BLOCKERS" 2>/dev/null; then
    # Ensure blockers file exists before sed_inplace (which may create an empty
    # file on some platforms if the target is missing)
    [ -f "$BLOCKERS" ] || touch "$BLOCKERS"
    sed_inplace 's/_No active blockers._//' "$BLOCKERS"
    echo "- **$(date '+%Y-%m-%d')**: TypeScript typecheck failing after $MAX_FIX_ATTEMPTS auto-fix attempts. Manual intervention needed." >> "$BLOCKERS"
  fi
fi

# --- Lint (informational, don't block on it) ---
if [ -n "$SKYNET_LINT_CMD" ]; then
  # Validate lint command against disallowed characters (defense-in-depth)
  case "$SKYNET_LINT_CMD" in *";"*|*"|"*|*'$('*|*'`'*) log "ERROR: SKYNET_LINT_CMD contains unsafe characters"; SKYNET_LINT_CMD="" ;; esac
fi
if [ -n "$SKYNET_LINT_CMD" ]; then
  log "Running lint..."
  if eval "$SKYNET_LINT_CMD" >> "$LOG" 2>&1; then
    log "Lint passed."
  else
    log "Lint has warnings/errors (non-blocking)."
  fi
else
  log "Lint skipped (SKYNET_LINT_CMD is empty)."
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
  tg "🏥 *$SKYNET_PROJECT_NAME_UPPER HEALTH*: All clear — typecheck passed, $uncommitted uncommitted files"
else
  log "Health check: ISSUES FOUND (see blockers.md)"
  tg "⚠️ *$SKYNET_PROJECT_NAME_UPPER HEALTH*: Typecheck failing after $MAX_FIX_ATTEMPTS auto-fix attempts. Needs manual review."
fi

log "Health check finished."
