#!/usr/bin/env bash
# _worktree.sh — Shared worktree setup/cleanup helpers for dev-worker and task-fixer
# Sourced by _config.sh after _merge.sh.
#
# Expects these variables from the sourcing script:
#   WORKTREE_DIR     — path to the worker/fixer worktree directory
#   PROJECT_DIR      — root project directory
#   SKYNET_MAIN_BRANCH — main branch name (e.g. "main")
#   SKYNET_WORKTREE_BASE — base directory for all worktrees
#   LOG              — log file path (for install output)
#
# Optional:
#   WORKTREE_INSTALL_STRICT — if "true" (default), return 1 on install failure.
#                             Set to "false" in task-fixer to continue anyway.
#   WORKTREE_DELETE_STALE_BRANCH — if "true", delete existing branch before
#                                  creating worktree from main (used by task-fixer).
#
# Provides:
#   setup_worktree BRANCH [FROM_MAIN]   — create worktree + install deps
#   cleanup_worktree [DELETE_BRANCH]     — remove worktree, optionally delete branch
#   WORKTREE_LAST_ERROR                 — set on failure for caller inspection

WORKTREE_LAST_ERROR=""

# Create a worktree for a feature branch. Installs deps via pnpm.
setup_worktree() {
  mkdir -p "$SKYNET_WORKTREE_BASE" 2>/dev/null || true
  local branch="$1"
  local from_main="${2:-true}"  # true = create new branch from main, false = use existing
  WORKTREE_LAST_ERROR=""

  # Clean any leftover worktree from previous runs
  cleanup_worktree 2>/dev/null || true

  if $from_main; then
    # Optionally delete stale branch before creating (task-fixer behavior)
    if [ "${WORKTREE_DELETE_STALE_BRANCH:-false}" = "true" ]; then
      if git show-ref --verify --quiet "refs/heads/$branch" 2>/dev/null; then
        log "Deleting stale branch $branch before creating worktree"
        git branch -D "$branch" 2>/dev/null || true
      fi
    fi
    if ! _wt_out=$(git worktree add "$WORKTREE_DIR" -b "$branch" "$SKYNET_MAIN_BRANCH" 2>&1); then
      log "Worktree add failed for $branch: $_wt_out"
      if echo "$_wt_out" | grep -qi "already used by worktree"; then
        WORKTREE_LAST_ERROR="branch_in_use"
      else
        WORKTREE_LAST_ERROR="worktree_add_failed"
      fi
      return 1
    fi
  else
    if ! _wt_out=$(git worktree add "$WORKTREE_DIR" "$branch" 2>&1); then
      log "Worktree add failed for existing branch $branch: $_wt_out"
      if echo "$_wt_out" | grep -qi "already used by worktree"; then
        WORKTREE_LAST_ERROR="branch_in_use"
      else
        WORKTREE_LAST_ERROR="worktree_add_failed"
      fi
      return 1
    fi
  fi
  if [ ! -d "$WORKTREE_DIR" ]; then
    log "Worktree directory missing after add: $WORKTREE_DIR"
    WORKTREE_LAST_ERROR="worktree_missing"
    return 1
  fi

  # Install dependencies (fast — pnpm content-addressable store is cached)
  log "Installing deps in worktree..."
  if ! (cd "$WORKTREE_DIR" && eval "${SKYNET_INSTALL_CMD:-pnpm install --frozen-lockfile}") >> "$LOG" 2>&1; then
    log "ERROR: Dependency install failed in worktree"
    if [ "${WORKTREE_INSTALL_STRICT:-true}" = "true" ]; then
      WORKTREE_LAST_ERROR="install_failed"
      return 1
    fi
    # Non-strict mode: continue to agent anyway — some projects don't need install
  fi
}

# Remove worktree. Optionally delete the branch too.
cleanup_worktree() {
  local delete_branch="${1:-}"
  cd "$PROJECT_DIR"  # ensure we're not inside the worktree
  if [ -d "$WORKTREE_DIR" ]; then
    git worktree remove "$WORKTREE_DIR" --force 2>/dev/null || rm -rf "$WORKTREE_DIR" 2>/dev/null || true
  fi
  git worktree prune 2>/dev/null || true
  if [ -n "$delete_branch" ]; then
    git branch -D "$delete_branch" 2>/dev/null || true
  fi
}
