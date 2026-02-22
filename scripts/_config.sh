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
export SKYNET_DEV_SERVER_URL="${SKYNET_DEV_SERVER_URL:-http://localhost:3000}"
export SKYNET_DEV_PORT="${SKYNET_DEV_PORT:-3000}"
export SKYNET_TYPECHECK_CMD="${SKYNET_TYPECHECK_CMD:-pnpm typecheck}"
export SKYNET_WORKTREE_BASE="${SKYNET_WORKTREE_BASE:-${SKYNET_DEV_DIR}/worktrees}"

# Quality gates defaults (just typecheck by default)
export SKYNET_GATE_1="${SKYNET_GATE_1:-$SKYNET_TYPECHECK_CMD}"

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

# --- Backlog health validation ---
# Checks: (1) no duplicate pending titles, (2) no orphaned [>] claims,
# (3) blockedBy refs point to existing tasks. Auto-fixes orphaned claims.
# Called from watchdog.sh on each run. Expects log() to be defined by caller.
validate_backlog() {
  [ -f "$BACKLOG" ] || return 0

  # Use caller's log() if available, else echo with timestamp to stderr
  _vb_log() {
    if declare -f log >/dev/null 2>&1; then log "$@"; else echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >&2; fi
  }

  local warnings=0
  local _lock_dir="${SKYNET_LOCK_PREFIX}-backlog.lock"

  # (1) Duplicate pending task titles
  # Extract title: strip checkbox, tag prefix, description, and blockedBy metadata
  local dupes
  dupes=$(grep '^\- \[ \]' "$BACKLOG" 2>/dev/null \
    | sed 's/^- \[ \] //;s/^\[[^]]*\] //;s/ | [bB]lockedBy:.*//;s/ —.*//' \
    | sort | uniq -d)
  if [ -n "$dupes" ]; then
    while IFS= read -r dup; do
      _vb_log "BACKLOG HEALTH: Duplicate pending title: $dup"
      warnings=$((warnings + 1))
    done <<< "$dupes"
  fi

  # (2) Orphaned [>] claims — no matching active worker in current-task-N.md
  local claimed_lines
  claimed_lines=$(grep '^\- \[>\]' "$BACKLOG" 2>/dev/null || true)
  if [ -n "$claimed_lines" ]; then
    while IFS= read -r line; do
      local title="${line#- \[>\] }"
      local has_worker=false

      # Check dev-workers
      for wid in $(seq 1 "${SKYNET_MAX_WORKERS:-4}"); do
        local wid_lock="${SKYNET_LOCK_PREFIX}-dev-worker-${wid}.lock"
        local _wid_pid=""
        if [ -d "$wid_lock" ] && [ -f "$wid_lock/pid" ]; then
          _wid_pid=$(cat "$wid_lock/pid" 2>/dev/null || echo "")
        elif [ -f "$wid_lock" ]; then
          _wid_pid=$(cat "$wid_lock" 2>/dev/null || echo "")
        fi
        [ -n "$_wid_pid" ] && kill -0 "$_wid_pid" 2>/dev/null || continue
        local task_file="$DEV_DIR/current-task-${wid}.md"
        [ -f "$task_file" ] && grep -q "in_progress" "$task_file" 2>/dev/null || continue
        local worker_title
        worker_title=$(grep "^##" "$task_file" 2>/dev/null | head -1 | sed 's/^## //')
        # Strip blockedBy metadata for comparison
        local clean_title="${title%% | blockedBy:*}"
        if [ "$worker_title" = "$clean_title" ]; then
          has_worker=true; break
        fi
      done

      # Check task-fixers (fixer 1 uses task-fixer.lock, fixers 2+ use task-fixer-N.lock)
      if ! $has_worker; then
        for _fid in $(seq 1 "${SKYNET_MAX_FIXERS:-3}"); do
          local _fixer_lock _fixer_task
          if [ "$_fid" = "1" ]; then
            _fixer_lock="${SKYNET_LOCK_PREFIX}-task-fixer.lock"
            _fixer_task="$DEV_DIR/current-task-fixer.md"
          else
            _fixer_lock="${SKYNET_LOCK_PREFIX}-task-fixer-${_fid}.lock"
            _fixer_task="$DEV_DIR/current-task-fixer-${_fid}.md"
          fi
          local _fixer_pid=""
          if [ -d "$_fixer_lock" ] && [ -f "$_fixer_lock/pid" ]; then
            _fixer_pid=$(cat "$_fixer_lock/pid" 2>/dev/null || echo "")
          elif [ -f "$_fixer_lock" ]; then
            _fixer_pid=$(cat "$_fixer_lock" 2>/dev/null || echo "")
          fi
          if [ -n "$_fixer_pid" ] && kill -0 "$_fixer_pid" 2>/dev/null; then
            if [ -f "$_fixer_task" ]; then
              local fixer_title
              fixer_title=$(grep "^##" "$_fixer_task" 2>/dev/null | head -1 | sed 's/^## //')
              local clean_title="${title%% | blockedBy:*}"
              if [ "$fixer_title" = "$clean_title" ]; then
                has_worker=true; break
              fi
            fi
          fi
        done
      fi

      if ! $has_worker; then
        _vb_log "BACKLOG HEALTH: Orphaned claim, resetting to pending: $title"
        # Auto-fix: reset [>] to [ ] with backlog mutex
        if mkdir "$_lock_dir" 2>/dev/null; then
          __AWK_TARGET="$line" awk 'BEGIN{target=ENVIRON["__AWK_TARGET"]} {
            if ($0 == target) sub(/\[>\]/, "[ ]")
            print
          }' "$BACKLOG" > "$BACKLOG.tmp" && mv "$BACKLOG.tmp" "$BACKLOG"
          rmdir "$_lock_dir" 2>/dev/null || rm -rf "$_lock_dir" 2>/dev/null || true
        fi
        warnings=$((warnings + 1))
      fi
    done <<< "$claimed_lines"
  fi

  # (3) blockedBy references must point to existing tasks in backlog or completed
  while IFS= read -r line; do
    local deps
    deps=$(echo "$line" | sed -n 's/.*| *[bB]locked[bB]y: *\(.*\)$/\1/p')
    [ -z "$deps" ] && continue
    local _old_ifs="$IFS"
    IFS=','
    # shellcheck disable=SC2086
    for dep in $deps; do
      dep=$(echo "$dep" | sed 's/^ *//;s/ *$//')
      [ -z "$dep" ] && continue
      local found=false
      # Check backlog (any status line containing the dep as substring)
      grep '^\- \[.\]' "$BACKLOG" 2>/dev/null | grep -qF "$dep" && found=true
      # Check completed.md
      if ! $found && [ -f "$COMPLETED" ]; then
        grep -qF "$dep" "$COMPLETED" 2>/dev/null && found=true
      fi
      if ! $found; then
        _vb_log "BACKLOG HEALTH: blockedBy ref not found: '$dep'"
        warnings=$((warnings + 1))
      fi
    done
    IFS="$_old_ifs"
  done < <(grep '| *blockedBy:' "$BACKLOG" 2>/dev/null || true)

  if [ "$warnings" -gt 0 ]; then
    _vb_log "Backlog validation: $warnings issue(s) found"
  fi

  return 0
}
