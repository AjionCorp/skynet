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
export SKYNET_MAX_WORKERS="${SKYNET_MAX_WORKERS:-2}"
export SKYNET_MAX_TASKS_PER_RUN="${SKYNET_MAX_TASKS_PER_RUN:-5}"
export SKYNET_STALE_MINUTES="${SKYNET_STALE_MINUTES:-45}"
export SKYNET_MAX_FIX_ATTEMPTS="${SKYNET_MAX_FIX_ATTEMPTS:-3}"
export SKYNET_CLAUDE_BIN="${SKYNET_CLAUDE_BIN:-claude}"
export SKYNET_CLAUDE_FLAGS="${SKYNET_CLAUDE_FLAGS:---print --dangerously-skip-permissions}"
export SKYNET_DEV_SERVER_URL="${SKYNET_DEV_SERVER_URL:-http://localhost:3000}"

# Convenience aliases used by all scripts
PROJECT_DIR="$SKYNET_PROJECT_DIR"
DEV_DIR="$SKYNET_DEV_DIR"
SCRIPTS_DIR="$SKYNET_DEV_DIR/scripts"
BACKLOG="$DEV_DIR/backlog.md"
COMPLETED="$DEV_DIR/completed.md"
FAILED="$DEV_DIR/failed-tasks.md"
BLOCKERS="$DEV_DIR/blockers.md"
CURRENT_TASK="$DEV_DIR/current-task.md"
SYNC_HEALTH="$DEV_DIR/sync-health.md"

# Source cross-platform compatibility layer
source "$SKYNET_SCRIPTS_DIR/_compat.sh"

# Source notification helpers
source "$SKYNET_SCRIPTS_DIR/_notify.sh"

# Source AI agent abstraction (Claude + Codex fallback)
source "$SKYNET_SCRIPTS_DIR/_agent.sh"
