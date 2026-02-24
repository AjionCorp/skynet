#!/usr/bin/env bash
# _config.sh — Skynet configuration loader
# Sourced by all skynet scripts. Finds and loads skynet.config.sh + skynet.project.sh

set -euo pipefail

# Seed $RANDOM with PID, nanosecond timestamp, and parent PID to reduce
# thundering herd when multiple workers start simultaneously from watchdog.
# date +%N provides nanosecond resolution on Linux; macOS lacks %N so falls
# back to 0. The XOR with $$ and $PPID ensures uniqueness even without %N.
# Strip leading zeros from %N to prevent bash octal interpretation (e.g., 090842000)
_skynet_ns=$(date +%N 2>/dev/null || echo 0)
_skynet_ns=${_skynet_ns##0}
_skynet_ns=${_skynet_ns:-0}
RANDOM=$((RANDOM ^ $$ ^ ${PPID:-0} ^ _skynet_ns))
unset _skynet_ns

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
# bash 3.2 compat: Cannot use ${!_var} with default values or nameref (declare -n
# requires bash 4.3+). The eval pattern is safe here because _var values come from
# a hardcoded list of SKYNET_* variable names, not user input.
for _var in SKYNET_PROJECT_NAME SKYNET_PROJECT_DIR SKYNET_DEV_DIR; do
  eval "_val=\${${_var}:-}"
  if [ -z "$_val" ]; then
    echo "FATAL: $_var is not set in skynet.config.sh" >&2
    exit 1
  fi
done

# Load project-specific overrides (optional)
[ -f "$SKYNET_DEV_DIR/skynet.project.sh" ] && source "$SKYNET_DEV_DIR/skynet.project.sh"

# Apply environment
export PATH="${SKYNET_EXTRA_PATH:-/opt/homebrew/bin:/usr/local/bin}:$PATH"

# Derived defaults
# SECURITY: Lock paths in /tmp/ are predictable and world-accessible on shared hosts.
# On multi-user systems, set SKYNET_LOCK_PREFIX to a user-private directory
# (e.g., $HOME/.cache/skynet/locks) to prevent local DoS via pre-created locks.
export SKYNET_LOCK_PREFIX="${SKYNET_LOCK_PREFIX:-/tmp/skynet-${SKYNET_PROJECT_NAME}}"

# OPS-P2-10: Warn if lock prefix directory is owned by a different user
# Collect all mismatches and log once at the end (don't break after the first).
_lock_dir_parent="$(dirname "$SKYNET_LOCK_PREFIX" 2>/dev/null || echo "/tmp")"
_lock_mismatches=""
_lock_mismatch_count=0
for _lock_check in "$_lock_dir_parent"/skynet-*; do
  [ -e "$_lock_check" ] || continue
  _lock_owner="$(stat -f%u "$_lock_check" 2>/dev/null || stat -c%u "$_lock_check" 2>/dev/null || echo "")"
  if [ -n "$_lock_owner" ] && [ "$_lock_owner" != "$(id -u)" ]; then
    _lock_mismatches="${_lock_mismatches}  - ${_lock_check} (UID ${_lock_owner})"$'\n'
    _lock_mismatch_count=$((_lock_mismatch_count + 1))
  fi
done
if [ "$_lock_mismatch_count" -gt 0 ]; then
  echo "WARNING: ${_lock_mismatch_count} lock path(s) owned by different UID (current user: $(id -u)). Risk of lock contention on shared hosts:" >&2
  printf '%s' "$_lock_mismatches" >&2
fi

# Auth token cache — stored in user-private directory, NOT world-readable /tmp
_skynet_token_dir="${HOME}/.cache/skynet"
mkdir -p "$_skynet_token_dir" 2>/dev/null && chmod 700 "$_skynet_token_dir" 2>/dev/null
export SKYNET_AUTH_TOKEN_CACHE="${SKYNET_AUTH_TOKEN_CACHE:-${_skynet_token_dir}/claude-token-${SKYNET_PROJECT_NAME}}"
export SKYNET_AUTH_FAIL_FLAG="${SKYNET_AUTH_FAIL_FLAG:-${_skynet_token_dir}/auth-failed-${SKYNET_PROJECT_NAME}}"
export SKYNET_AUTH_KEYCHAIN_ACCOUNT="${SKYNET_AUTH_KEYCHAIN_ACCOUNT:-${USER}}"
export SKYNET_BRANCH_PREFIX="${SKYNET_BRANCH_PREFIX:-dev/}"
export SKYNET_MAIN_BRANCH="${SKYNET_MAIN_BRANCH:-main}"
export SKYNET_MAX_WORKERS="${SKYNET_MAX_WORKERS:-4}"
export SKYNET_MAX_FIXERS="${SKYNET_MAX_FIXERS:-3}"
export SKYNET_MAX_TASKS_PER_RUN="${SKYNET_MAX_TASKS_PER_RUN:-5}"
export SKYNET_STALE_MINUTES="${SKYNET_STALE_MINUTES:-30}"
export SKYNET_AGENT_TIMEOUT_MINUTES="${SKYNET_AGENT_TIMEOUT_MINUTES:-45}"
export SKYNET_MAX_FIX_ATTEMPTS="${SKYNET_MAX_FIX_ATTEMPTS:-3}"
export SKYNET_FIXER_IGNORE_USAGE_LIMIT="${SKYNET_FIXER_IGNORE_USAGE_LIMIT:-true}"
export SKYNET_DRIVER_BACKLOG_THRESHOLD="${SKYNET_DRIVER_BACKLOG_THRESHOLD:-5}"
export SKYNET_MAX_LOG_SIZE_KB="${SKYNET_MAX_LOG_SIZE_KB:-1024}"
export SKYNET_CLAUDE_BIN="${SKYNET_CLAUDE_BIN:-claude}"
# --dangerously-skip-permissions is required for autonomous workers to modify files
# without interactive approval prompts. Only safe in isolated worktrees where no
# user-owned files outside the project are at risk.
# NOTE: Claude Code reads auth tokens from its own config (~/.claude/),
# not from command-line arguments. Tokens are NOT visible in /proc/PID/cmdline.
export SKYNET_CLAUDE_FLAGS="${SKYNET_CLAUDE_FLAGS:---print --dangerously-skip-permissions}"
export SKYNET_CODEX_MODEL="${SKYNET_CODEX_MODEL:-}"
export SKYNET_CODEX_SUBCOMMAND="${SKYNET_CODEX_SUBCOMMAND:-exec}"
export SKYNET_CODEX_AUTH_FILE="${SKYNET_CODEX_AUTH_FILE:-$HOME/.codex/auth.json}"
export SKYNET_CODEX_AUTH_FAIL_FLAG="${SKYNET_CODEX_AUTH_FAIL_FLAG:-${_skynet_token_dir}/codex-auth-failed-${SKYNET_PROJECT_NAME}}"
export SKYNET_CODEX_REFRESH_BUFFER_SECS="${SKYNET_CODEX_REFRESH_BUFFER_SECS:-900}"
export SKYNET_CODEX_OAUTH_ISSUER="${SKYNET_CODEX_OAUTH_ISSUER:-}"
export SKYNET_GEMINI_BIN="${SKYNET_GEMINI_BIN:-gemini}"
export SKYNET_GEMINI_FLAGS="${SKYNET_GEMINI_FLAGS:--p}"
export SKYNET_GEMINI_MODEL="${SKYNET_GEMINI_MODEL:-}"
export SKYNET_GEMINI_AUTH_FAIL_FLAG="${SKYNET_GEMINI_AUTH_FAIL_FLAG:-${_skynet_token_dir}/gemini-auth-failed-${SKYNET_PROJECT_NAME}}"
export SKYNET_GEMINI_NOTIFY_INTERVAL="${SKYNET_GEMINI_NOTIFY_INTERVAL:-3600}"
export SKYNET_DEV_SERVER_URL="${SKYNET_DEV_SERVER_URL:-http://localhost:3000}"
export SKYNET_DEV_PORT="${SKYNET_DEV_PORT:-${SKYNET_DEV_SERVER_PORT:-3000}}"
export SKYNET_TYPECHECK_CMD="${SKYNET_TYPECHECK_CMD:-pnpm typecheck}"
export SKYNET_LINT_CMD="${SKYNET_LINT_CMD:-}"  # empty string means "skip lint gate"
export SKYNET_WORKTREE_BASE="${SKYNET_WORKTREE_BASE:-${SKYNET_DEV_DIR}/worktrees}"

# Memory limit per worker process in KB (default 4GB). Applied via ulimit -v.
export SKYNET_WORKER_MEM_LIMIT_KB="${SKYNET_WORKER_MEM_LIMIT_KB:-4194304}"

# Log format: "text" (default, human-readable) or "json" (machine-parseable JSON lines)
export SKYNET_LOG_FORMAT="${SKYNET_LOG_FORMAT:-text}"

# Minimum free disk space (MB) before DB writes emit CRITICAL warning
# OPS-P2-5: Increased from 50MB to 100MB to account for WAL growth under load
export SKYNET_MIN_DISK_MB="${SKYNET_MIN_DISK_MB:-100}"

# SQL debug mode: log every query with timing. Default off for zero overhead.
export SKYNET_DB_DEBUG="${SKYNET_DB_DEBUG:-false}"
# Slow query warning threshold in milliseconds
export SKYNET_DB_SLOW_QUERY_MS="${SKYNET_DB_SLOW_QUERY_MS:-100}"

# Lock backend: "file" (default flock/mkdir) or "redis" (distributed, requires redis-cli)
export SKYNET_LOCK_BACKEND="${SKYNET_LOCK_BACKEND:-file}"
# Redis URL for distributed locking (only used when SKYNET_LOCK_BACKEND=redis)
export SKYNET_REDIS_URL="${SKYNET_REDIS_URL:-}"

# Dry-run mode: run the full pipeline loop without executing agents,
# claiming tasks, or pushing to git. Useful for testing config changes.
export SKYNET_DRY_RUN="${SKYNET_DRY_RUN:-false}"

# Quality gates defaults (just typecheck by default)
export SKYNET_GATE_1="${SKYNET_GATE_1:-$SKYNET_TYPECHECK_CMD}"

# Post-merge smoke test (set to "true" to enable runtime validation after merge)
export SKYNET_POST_MERGE_SMOKE="${SKYNET_POST_MERGE_SMOKE:-false}"
export SKYNET_SMOKE_TIMEOUT="${SKYNET_SMOKE_TIMEOUT:-10}"

# Post-merge typecheck gate (validates main still builds after merge; auto-reverts on failure)
export SKYNET_POST_MERGE_TYPECHECK="${SKYNET_POST_MERGE_TYPECHECK:-true}"

# Timeout (seconds) for each git push attempt (prevents indefinite hang on network stalls).
# 120s accommodates large diffs and slow networks; override via env var if needed.
export SKYNET_GIT_PUSH_TIMEOUT="${SKYNET_GIT_PUSH_TIMEOUT:-120}"

# OPS-P2-5: General git operation timeout (pull, fetch). Defaults to the push timeout.
export SKYNET_GIT_TIMEOUT="${SKYNET_GIT_TIMEOUT:-${SKYNET_GIT_PUSH_TIMEOUT:-120}}"

# Orphan process cutoff: processes older than this are considered orphans.
export SKYNET_ORPHAN_CUTOFF_SECONDS="${SKYNET_ORPHAN_CUTOFF_SECONDS:-120}"

# Canary deployment: when enabled, script changes (scripts/*.sh) trigger single-worker
# validation before full dispatch. Prevents self-modifying bugs from crashing all workers.
export SKYNET_CANARY_ENABLED="${SKYNET_CANARY_ENABLED:-true}"
# Auto-clear canary after this many minutes if no crash detected (prevents pipeline stall)
export SKYNET_CANARY_TIMEOUT_MINUTES="${SKYNET_CANARY_TIMEOUT_MINUTES:-30}"

# NOTE: .dev/ is inside the git repo for convenience. Ensure it is not
# served by any web server (add to .dockerignore, nginx deny rules, etc.).

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

# --- Startup config validation ---
_validate_config() {
  local errors=0
  # Validate gate commands exist
  for _gate_var in SKYNET_GATE_1 SKYNET_GATE_2 SKYNET_GATE_3; do
    eval "local _gate_val=\${${_gate_var}:-}"
    [ -z "$_gate_val" ] && continue
    local _gate_cmd="${_gate_val%% *}"  # first word
    if ! command -v "$_gate_cmd" >/dev/null 2>&1; then
      echo "WARNING: $_gate_var command '$_gate_cmd' not found in PATH" >&2
    fi
  done
  # Validate numeric configs
  for _num_var in SKYNET_MAX_WORKERS SKYNET_MAX_FIXERS SKYNET_STALE_MINUTES SKYNET_AGENT_TIMEOUT_MINUTES; do
    eval "local _num_val=\${${_num_var}:-}"
    case "$_num_val" in
      ''|*[!0-9]*) echo "WARNING: $_num_var='$_num_val' is not a positive integer" >&2; errors=$((errors + 1)) ;;
    esac
  done
  # Validate executable config values against allowed character set
  for _exec_var in SKYNET_GATE_1 SKYNET_GATE_2 SKYNET_GATE_3 SKYNET_INSTALL_CMD SKYNET_TYPECHECK_CMD SKYNET_LINT_CMD SKYNET_DEV_SERVER_CMD SKYNET_CLAUDE_BIN SKYNET_CODEX_BIN SKYNET_GEMINI_BIN; do
    eval "local _exec_val=\${${_exec_var}:-}"
    [ -z "$_exec_val" ] && continue
    case "$_exec_val" in
      *".."*) echo "WARNING: $_exec_var contains path traversal" >&2; errors=$((errors + 1)) ;;
      *[^a-zA-Z0-9\ ./_:=-]*) echo "WARNING: $_exec_var='$_exec_val' contains disallowed characters" >&2; errors=$((errors + 1)) ;;
    esac
  done
  # Validate lock backend
  local critical=0
  if [ "${SKYNET_LOCK_BACKEND:-file}" = "redis" ]; then
    if [ -z "${SKYNET_REDIS_URL:-}" ]; then
      echo "ERROR: SKYNET_LOCK_BACKEND=redis requires SKYNET_REDIS_URL to be set" >&2
      errors=$((errors + 1))
      critical=$((critical + 1))
    fi
    if ! command -v "${SKYNET_REDIS_CLI:-redis-cli}" >/dev/null 2>&1; then
      echo "ERROR: SKYNET_LOCK_BACKEND=redis requires redis-cli in PATH" >&2
      errors=$((errors + 1))
      critical=$((critical + 1))
    fi
  fi
  [ "$critical" -eq 0 ]
}
_validate_config

# OPS-P2-11: Validate and clamp numeric config fields to safe bounds
_validate_config_numerics() {
  _clamp() {
    local var_name="$1" min="$2" max="$3"
    eval "local val=\${${var_name}:-}"
    case "$val" in ''|*[!0-9]*) return ;; esac  # skip non-numeric
    if [ "$val" -lt "$min" ]; then
      local _msg="ERROR: ${var_name}=${val} below minimum ${min} — clamping to ${min}. Update your config to silence this."
      echo "$_msg" >&2
      # SH-P1-5: Also log to main log file so operators see clamping in persistent logs
      if declare -f log >/dev/null 2>&1; then
        log "$_msg"
      elif [ -n "${SCRIPTS_DIR:-}" ] && [ -d "${SCRIPTS_DIR:-}" ]; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] [CONFIG] $_msg" >> "${SCRIPTS_DIR}/watchdog.log" 2>/dev/null || true
      fi
      eval "export ${var_name}=${min}"
    elif [ "$val" -gt "$max" ]; then
      local _msg="ERROR: ${var_name}=${val} above maximum ${max} — clamping to ${max}. Update your config to silence this."
      echo "$_msg" >&2
      # SH-P1-5: Also log to main log file so operators see clamping in persistent logs
      if declare -f log >/dev/null 2>&1; then
        log "$_msg"
      elif [ -n "${SCRIPTS_DIR:-}" ] && [ -d "${SCRIPTS_DIR:-}" ]; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] [CONFIG] $_msg" >> "${SCRIPTS_DIR}/watchdog.log" 2>/dev/null || true
      fi
      eval "export ${var_name}=${max}"
    fi
  }
  _clamp SKYNET_STALE_MINUTES 5 240
  _clamp SKYNET_AGENT_TIMEOUT_MINUTES 10 240
  _clamp SKYNET_MAX_WORKERS 1 16
  _clamp SKYNET_WATCHDOG_INTERVAL 30 600
}
_validate_config_numerics

# Source cross-platform compatibility layer
source "$SKYNET_SCRIPTS_DIR/_compat.sh"

# Precompute uppercase project name (bash 3.2 doesn't support ${VAR^^})
# shellcheck disable=SC2034
SKYNET_PROJECT_NAME_UPPER="$(to_upper "$SKYNET_PROJECT_NAME")"

# Source notification helpers
source "$SKYNET_SCRIPTS_DIR/_notify.sh"

# One-time warning if no notification channels are configured.
# Uses a sentinel file so the warning appears once per project, not on every script invocation.
_notify_warn_sentinel="$SKYNET_DEV_DIR/.notify-warn-shown"
if [ -z "${SKYNET_NOTIFY_CHANNELS:-}" ] || [ "${SKYNET_NOTIFY_CHANNELS:-}" = "none" ]; then
  if [ ! -f "$_notify_warn_sentinel" ]; then
    echo "WARNING: No notification channels configured (SKYNET_NOTIFY_CHANNELS is empty)." >&2
    echo "  Pipeline events will only be logged. Set SKYNET_NOTIFY_CHANNELS in skynet.config.sh." >&2
    touch "$_notify_warn_sentinel" 2>/dev/null || true
  fi
fi

# Source structured event logging
source "$SKYNET_SCRIPTS_DIR/_events.sh"

# Source AI agent abstraction (plugin-based — see scripts/agents/)
source "$SKYNET_SCRIPTS_DIR/_agent.sh"

# Source skill discovery and tag-filtered injection (see .dev/skills/)
source "$SKYNET_SCRIPTS_DIR/_skills.sh"

# Source pluggable lock backend (needed by _locks.sh)
source "$SKYNET_SCRIPTS_DIR/_lock_backend.sh"

# Source shared lock helpers (merge mutex, etc.)
source "$SKYNET_SCRIPTS_DIR/_locks.sh"

# Source shared merge-to-main logic (needs _locks.sh for merge mutex)
source "$SKYNET_SCRIPTS_DIR/_merge.sh"

# Source shared worktree setup/cleanup helpers (used by dev-worker, task-fixer)
source "$SKYNET_SCRIPTS_DIR/_worktree.sh"

# Source SQLite database abstraction layer
source "$SKYNET_SCRIPTS_DIR/_db.sh"
if [ "${_SKYNET_DB_INITIALIZED:-}" != "1" ]; then
  db_init
  _SKYNET_DB_INITIALIZED=1
fi

# --- Structured logging ---
# Shared log formatter. When SKYNET_LOG_FORMAT=json, outputs JSON lines.
# Each script's log() delegates to _log() with its worker label and log file.
_json_escape() {
  local s="$1"
  # NOTE: Forward slashes (/) are NOT escaped. JSON spec (RFC 8259 §7) allows
  # but does not require \/ escaping. Omitting it keeps output readable and
  # is safe for all JSON parsers.
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\r'/\\r}"
  s="${s//$'\t'/\\t}"
  # Strip remaining ASCII control chars 0x00-0x1F (tab/newline/CR already handled above)
  s=$(printf '%s' "$s" | tr -d '\001-\010\013\014\016-\037')
  printf '%s' "$s"
}

_log() {
  local level="${1:-info}" label="$2" msg="$3" logfile="${4:-}"
  local line
  if [ "${SKYNET_LOG_FORMAT:-text}" = "json" ]; then
    local ts
    ts=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
    # Include trace_id in JSON output when TRACE_ID is set (task lifecycle tracing).
    # TRACE_ID is set by dev-worker.sh and task-fixer.sh per claimed task.
    local _trace_field=""
    if [ -n "${TRACE_ID:-}" ]; then
      _trace_field=$(printf ',"trace_id":"%s"' "$(_json_escape "$TRACE_ID")")
    fi
    line=$(printf '{"ts":"%s","level":"%s","worker":"%s","msg":"%s"%s}' \
      "$ts" "$level" "$(_json_escape "$label")" "$(_json_escape "$msg")" "$_trace_field")
  else
    line="[$(date '+%Y-%m-%d %H:%M:%S')]"
    [ -n "$label" ] && line="$line [$label]"
    line="$line $msg"
  fi
  if [ -n "$logfile" ]; then
    printf '%s\n' "$line" >> "$logfile"
  else
    printf '%s\n' "$line"
  fi
}

# NOTE: Individual scripts define their own log() to append to their specific LOG file.
# This is intentional — each worker needs its own log destination.
# Each log() calls _log() with the script's label and destination.

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
    # Use mkdir lock to prevent concurrent rotation
    local _rotate_lock="${logfile}.rotate-lock"
    if mkdir "$_rotate_lock" 2>/dev/null; then
      # Re-check size after acquiring lock (another process may have rotated)
      current_size=$(file_size "$logfile")
      if [ "$current_size" -gt "$max_bytes" ]; then
        rm -f "${logfile}.2" "${logfile}.2.gz"
        [ -f "${logfile}.1" ] && mv "${logfile}.1" "${logfile}.2"
        mv "$logfile" "${logfile}.1"
        # Compress the older backup to save disk space
        [ -f "${logfile}.2" ] && gzip -f "${logfile}.2" 2>/dev/null &
      fi
      rmdir "$_rotate_lock" 2>/dev/null || true
    fi
    # If we didn't get the lock, another process is rotating — skip
  fi
}

# --- Task lifecycle trace ID ---
# Generate a short trace ID for task lifecycle tracing.
# Uses /dev/urandom for randomness, falls back to PID+epoch.
_generate_trace_id() {
  local id
  id=$(head -c 8 /dev/urandom 2>/dev/null | od -An -tx1 2>/dev/null | tr -d ' \n' | head -c 12)
  if [ -z "$id" ]; then
    id="$$-$(date +%s)"
  fi
  printf '%s' "$id"
}

# --- Git helpers ---
# Pull from origin with retry. Returns 0 on success, 1 on failure.
# OPS-P2-5: Wrapped with SKYNET_GIT_TIMEOUT to prevent indefinite hangs.
# OPS-P2-9: Uses exponential backoff (1, 2, 4s) between retries.
# Usage: git_pull_with_retry [max_attempts]
git_pull_with_retry() {
  local max_attempts="${1:-3}"
  local attempt=1
  local backoff=1
  local _gpr_start
  _gpr_start=$(date +%s)
  while [ "$attempt" -le "$max_attempts" ]; do
    # SH-P2-2: Cap total elapsed time across all retries to 180s
    local _gpr_elapsed=$(( $(date +%s) - _gpr_start ))
    if [ "$_gpr_elapsed" -gt 180 ]; then
      log "ERROR: git pull total time exceeded 180s (${_gpr_elapsed}s) — aborting"
      return 1
    fi
    [ "$attempt" -gt 1 ] && log "git pull attempt $attempt/$max_attempts..."
    if run_with_timeout "${SKYNET_GIT_TIMEOUT:-120}" git pull origin "$SKYNET_MAIN_BRANCH" 2>>"${LOG:-/dev/null}"; then
      return 0
    fi
    log "git pull failed (attempt $attempt/$max_attempts)"
    attempt=$((attempt + 1))
    [ "$attempt" -le "$max_attempts" ] && sleep "$backoff"
    backoff=$((backoff * 2))
  done
  log "ERROR: git pull failed after $max_attempts attempts"
  return 1
}

# Push to origin with retry. Returns 0 on success, 1 on failure.
# OPS-P2-9: Uses exponential backoff (1, 2, 4s) between retries.
# Usage: git_push_with_retry [max_attempts]
git_push_with_retry() {
  local max_attempts="${1:-3}"
  local attempt=1
  local backoff=1

  # OPS-P2-2: Adaptive push timeout — double timeout for large diffs (>5000 lines)
  # to avoid unnecessary reverts on slow networks. Capped at 300s.
  local _push_timeout="$SKYNET_GIT_PUSH_TIMEOUT"
  local _diff_lines=0
  local _diff_stat
  _diff_stat=$(git diff --stat --cached 2>/dev/null | tail -1)
  if [ -n "$_diff_stat" ]; then
    # Extract insertions and deletions from "N files changed, X insertions(+), Y deletions(-)"
    local _insertions _deletions
    _insertions=$(printf '%s' "$_diff_stat" | sed -n 's/.*[[:space:]]\([0-9][0-9]*\) insertion.*/\1/p')
    _deletions=$(printf '%s' "$_diff_stat" | sed -n 's/.*[[:space:]]\([0-9][0-9]*\) deletion.*/\1/p')
    _diff_lines=$(( ${_insertions:-0} + ${_deletions:-0} ))
  fi
  if [ "$_diff_lines" -gt 5000 ]; then
    _push_timeout=$(( SKYNET_GIT_PUSH_TIMEOUT * 2 ))
    # Cap at 300s
    if [ "$_push_timeout" -gt 300 ]; then
      _push_timeout=300
    fi
    log "Large diff detected (${_diff_lines} lines), using extended push timeout (${_push_timeout}s)"
  fi

  local _gps_start
  _gps_start=$(date +%s)
  while [ "$attempt" -le "$max_attempts" ]; do
    # SH-P2-2: Cap total elapsed time across all retries to 180s
    local _gps_elapsed=$(( $(date +%s) - _gps_start ))
    if [ "$_gps_elapsed" -gt 180 ]; then
      log "ERROR: git push total time exceeded 180s (${_gps_elapsed}s) — aborting"
      return 1
    fi
    [ "$attempt" -gt 1 ] && log "git push attempt $attempt/$max_attempts..."
    if run_with_timeout "$_push_timeout" git push origin "$SKYNET_MAIN_BRANCH" 2>>"${LOG:-/dev/null}"; then
      return 0
    fi
    log "git push failed (attempt $attempt/$max_attempts)"
    attempt=$((attempt + 1))
    [ "$attempt" -le "$max_attempts" ] && sleep "$backoff"
    backoff=$((backoff * 2))
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
