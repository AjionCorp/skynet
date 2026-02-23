#!/usr/bin/env bash
# _config.sh — Skynet configuration loader
# Sourced by all skynet scripts. Finds and loads skynet.config.sh + skynet.project.sh

set -euo pipefail

# Resolve the scripts directory (where this file lives)
SKYNET_SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Find config: check SKYNET_DEV_DIR env, then look relative to scripts dir,
# then look for .dev/skynet.config.sh in working directory
_find_config() {
  local candidates=(
    "${SKYNET_DEV_DIR:-}/skynet.config.sh"
    "$SKYNET_SCRIPTS_DIR/../skynet.config.sh"
    "$PWD/.dev/skynet.config.sh"
  )
  for c in "${candidates[@]}"; do
    [ -f "$c" ] && echo "$c" && return 0
  done
  return 1
}

SKYNET_CONFIG_FILE="$(_find_config)" || {
  echo "FATAL: skynet.config.sh not found. Run 'npx skynet init' first." >&2
  exit 1
}

# shellcheck source=/dev/null
source "$SKYNET_CONFIG_FILE"

# Validate required variables
for _var in SKYNET_PROJECT_NAME SKYNET_PROJECT_DIR SKYNET_DEV_DIR; do
  if [ -z "${!_var:-}" ]; then
    echo "FATAL: $_var is not set in skynet.config.sh" >&2
    exit 1
  fi
done

# Load project-specific overrides (optional)
[ -f "$SKYNET_DEV_DIR/skynet.project.sh" ] && source "$SKYNET_DEV_DIR/skynet.project.sh"

# Apply environment
export PATH="${SKYNET_EXTRA_PATH:-/opt/homebrew/bin:/usr/local/bin}:$PATH"

# Derived defaults
export SKYNET_LOCK_PREFIX="${SKYNET_LOCK_PREFIX:-/tmp/skynet-${SKYNET_PROJECT_NAME}}"
export SKYNET_AUTH_TOKEN_CACHE="${SKYNET_AUTH_TOKEN_CACHE:-${SKYNET_LOCK_PREFIX}-claude-token}"
export SKYNET_AUTH_FAIL_FLAG="${SKYNET_AUTH_FAIL_FLAG:-${SKYNET_LOCK_PREFIX}-auth-failed}"
export SKYNET_AUTH_KEYCHAIN_ACCOUNT="${SKYNET_AUTH_KEYCHAIN_ACCOUNT:-${USER}}"
export SKYNET_BRANCH_PREFIX="${SKYNET_BRANCH_PREFIX:-dev/}"
export SKYNET_MAIN_BRANCH="${SKYNET_MAIN_BRANCH:-main}"
export SKYNET_MAX_WORKERS="${SKYNET_MAX_WORKERS:-4}"
export SKYNET_MAX_FIXERS="${SKYNET_MAX_FIXERS:-3}"
export SKYNET_MAX_TASKS_PER_RUN="${SKYNET_MAX_TASKS_PER_RUN:-5}"
export SKYNET_STALE_MINUTES="${SKYNET_STALE_MINUTES:-45}"
export SKYNET_AGENT_TIMEOUT_MINUTES="${SKYNET_AGENT_TIMEOUT_MINUTES:-45}"
export SKYNET_MAX_FIX_ATTEMPTS="${SKYNET_MAX_FIX_ATTEMPTS:-3}"
export SKYNET_FIXER_IGNORE_USAGE_LIMIT="${SKYNET_FIXER_IGNORE_USAGE_LIMIT:-true}"
export SKYNET_DRIVER_BACKLOG_THRESHOLD="${SKYNET_DRIVER_BACKLOG_THRESHOLD:-5}"
export SKYNET_MAX_LOG_SIZE_KB="${SKYNET_MAX_LOG_SIZE_KB:-1024}"
export SKYNET_CLAUDE_BIN="${SKYNET_CLAUDE_BIN:-claude}"
export SKYNET_CLAUDE_FLAGS="${SKYNET_CLAUDE_FLAGS:---print --dangerously-skip-permissions}"
export SKYNET_CODEX_MODEL="${SKYNET_CODEX_MODEL:-}"
export SKYNET_CODEX_SUBCOMMAND="${SKYNET_CODEX_SUBCOMMAND:-exec}"
export SKYNET_CODEX_AUTH_FILE="${SKYNET_CODEX_AUTH_FILE:-$HOME/.codex/auth.json}"
export SKYNET_CODEX_AUTH_FAIL_FLAG="${SKYNET_CODEX_AUTH_FAIL_FLAG:-${SKYNET_LOCK_PREFIX}-codex-auth-failed}"
export SKYNET_CODEX_REFRESH_BUFFER_SECS="${SKYNET_CODEX_REFRESH_BUFFER_SECS:-900}"
export SKYNET_CODEX_OAUTH_ISSUER="${SKYNET_CODEX_OAUTH_ISSUER:-}"
export SKYNET_GEMINI_BIN="${SKYNET_GEMINI_BIN:-gemini}"
export SKYNET_GEMINI_FLAGS="${SKYNET_GEMINI_FLAGS:--p}"
export SKYNET_GEMINI_MODEL="${SKYNET_GEMINI_MODEL:-}"
export SKYNET_GEMINI_AUTH_FAIL_FLAG="${SKYNET_GEMINI_AUTH_FAIL_FLAG:-${SKYNET_LOCK_PREFIX}-gemini-auth-failed}"
export SKYNET_GEMINI_NOTIFY_INTERVAL="${SKYNET_GEMINI_NOTIFY_INTERVAL:-3600}"
export SKYNET_DEV_SERVER_URL="${SKYNET_DEV_SERVER_URL:-http://localhost:3000}"
export SKYNET_DEV_PORT="${SKYNET_DEV_PORT:-${SKYNET_DEV_SERVER_PORT:-3000}}"
export SKYNET_TYPECHECK_CMD="${SKYNET_TYPECHECK_CMD:-pnpm typecheck}"
export SKYNET_LINT_CMD="${SKYNET_LINT_CMD:-}"  # empty string means "skip lint gate"
export SKYNET_WORKTREE_BASE="${SKYNET_WORKTREE_BASE:-${SKYNET_DEV_DIR}/worktrees}"

# Quality gates defaults (just typecheck by default)
export SKYNET_GATE_1="${SKYNET_GATE_1:-$SKYNET_TYPECHECK_CMD}"

# Post-merge smoke test (set to "true" to enable runtime validation after merge)
export SKYNET_POST_MERGE_SMOKE="${SKYNET_POST_MERGE_SMOKE:-false}"
export SKYNET_SMOKE_TIMEOUT="${SKYNET_SMOKE_TIMEOUT:-10}"

# Post-merge typecheck gate (validates main still builds after merge; auto-reverts on failure)
export SKYNET_POST_MERGE_TYPECHECK="${SKYNET_POST_MERGE_TYPECHECK:-true}"

# Timeout (seconds) for each git push attempt (prevents indefinite hang on network stalls)
export SKYNET_GIT_PUSH_TIMEOUT="${SKYNET_GIT_PUSH_TIMEOUT:-30}"

# Convenience aliases used by all scripts (sourced externally)
# shellcheck disable=SC2034
PROJECT_DIR="$SKYNET_PROJECT_DIR"
DEV_DIR="$SKYNET_DEV_DIR"
# shellcheck disable=SC2034
SCRIPTS_DIR="$SKYNET_DEV_DIR/scripts"
# shellcheck disable=SC2034
BACKLOG="$DEV_DIR/backlog.md"
# shellcheck disable=SC2034
COMPLETED="$DEV_DIR/completed.md"
# shellcheck disable=SC2034
FAILED="$DEV_DIR/failed-tasks.md"
# shellcheck disable=SC2034
BLOCKERS="$DEV_DIR/blockers.md"
# shellcheck disable=SC2034
CURRENT_TASK="$DEV_DIR/current-task.md"
# shellcheck disable=SC2034
SYNC_HEALTH="$DEV_DIR/sync-health.md"
# shellcheck disable=SC2034
MISSION="$DEV_DIR/mission.md"

# Source cross-platform compatibility layer
source "$SKYNET_SCRIPTS_DIR/_compat.sh"

# Precompute uppercase project name (bash 3.2 doesn't support ${VAR^^})
# shellcheck disable=SC2034
SKYNET_PROJECT_NAME_UPPER="$(to_upper "$SKYNET_PROJECT_NAME")"

# Source notification helpers
source "$SKYNET_SCRIPTS_DIR/_notify.sh"

# Source structured event logging
source "$SKYNET_SCRIPTS_DIR/_events.sh"

# Source AI agent abstraction (plugin-based — see scripts/agents/)
source "$SKYNET_SCRIPTS_DIR/_agent.sh"

# Source skill discovery and tag-filtered injection (see .dev/skills/)
source "$SKYNET_SCRIPTS_DIR/_skills.sh"

# Source shared lock helpers (merge mutex, etc.)
source "$SKYNET_SCRIPTS_DIR/_locks.sh"

# Source shared merge-to-main logic (needs _locks.sh for merge mutex)
source "$SKYNET_SCRIPTS_DIR/_merge.sh"

# Source SQLite database abstraction layer
source "$SKYNET_SCRIPTS_DIR/_db.sh"
if [ "${_SKYNET_DB_INITIALIZED:-}" != "1" ]; then
  db_init
  _SKYNET_DB_INITIALIZED=1
fi

# --- Log rotation ---
# Rotates a log file if it exceeds SKYNET_MAX_LOG_SIZE_KB.
# Keeps max 2 rotated copies: $logfile.1 (newest) and $logfile.2 (oldest).
rotate_log_if_needed() {
  local logfile="$1"
  [ -f "$logfile" ] || return 0
  local max_bytes=$(( SKYNET_MAX_LOG_SIZE_KB * 1024 ))
  local current_size
  current_size=$(file_size "$logfile")
  if [ "$current_size" -gt "$max_bytes" ]; then
    rm -f "${logfile}.2"
    [ -f "${logfile}.1" ] && mv "${logfile}.1" "${logfile}.2"
    mv "$logfile" "${logfile}.1"
  fi
}

# --- Git helpers ---
# Pull from origin with retry. Returns 0 on success, 1 on failure.
# Usage: git_pull_with_retry [max_attempts]
git_pull_with_retry() {
  local max_attempts="${1:-3}"
  local attempt=1
  while [ "$attempt" -le "$max_attempts" ]; do
    if git pull origin "$SKYNET_MAIN_BRANCH" 2>>"${LOG:-/dev/null}"; then
      return 0
    fi
    log "git pull failed (attempt $attempt/$max_attempts)"
    attempt=$((attempt + 1))
    [ "$attempt" -le "$max_attempts" ] && sleep "$((attempt * 2))"
  done
  log "ERROR: git pull failed after $max_attempts attempts"
  return 1
}

# Push to origin with retry. Returns 0 on success, 1 on failure.
# Usage: git_push_with_retry [max_attempts]
git_push_with_retry() {
  local max_attempts="${1:-3}"
  local attempt=1
  while [ "$attempt" -le "$max_attempts" ]; do
    if run_with_timeout "$SKYNET_GIT_PUSH_TIMEOUT" git push origin "$SKYNET_MAIN_BRANCH" 2>>"${LOG:-/dev/null}"; then
      return 0
    fi
    log "git push failed (attempt $attempt/$max_attempts)"
    attempt=$((attempt + 1))
    [ "$attempt" -le "$max_attempts" ] && sleep "$((attempt * 2))"
  done
  log "ERROR: git push failed after $max_attempts attempts"
  return 1
}

# --- Backlog health validation (SQLite-based) ---
# Checks: (1) no duplicate pending titles, (2) orphaned claims handled by
# watchdog SQLite reconciliation. Called from watchdog.sh on each run.
validate_backlog() {
  [ -f "$DB_PATH" ] || return 0

  _vb_log() {
    if declare -f log >/dev/null 2>&1; then log "$@"; else echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >&2; fi
  }

  local warnings=0

  # (1) Duplicate pending task titles
  local dupes
  dupes=$(sqlite3 "$DB_PATH" "SELECT title FROM tasks WHERE status='pending' GROUP BY title HAVING COUNT(*) > 1;" 2>/dev/null || true)
  if [ -n "$dupes" ]; then
    while IFS= read -r dup; do
      _vb_log "BACKLOG HEALTH: Duplicate pending title in SQLite: $dup"
      warnings=$((warnings + 1))
    done <<< "$dupes"
  fi

  # (2) Orphaned claimed tasks are handled by watchdog SQLite reconciliation
  # (no file-based check needed — SQLite is the source of truth)

  if [ "$warnings" -gt 0 ]; then
    _vb_log "Backlog validation: $warnings issue(s) found"
  fi

  return 0
}
