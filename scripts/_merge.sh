#!/usr/bin/env bash
# _merge.sh — Shared merge-to-main logic for dev-worker and task-fixer
# Sourced by _config.sh after _locks.sh.
#
# Provides do_merge_to_main() which encapsulates:
#   1. Acquire merge lock
#   2. Pull latest main
#   3. Merge branch (ff-first, then regular, then rebase recovery)
#   4. Post-merge typecheck with auto-revert on failure
#   5. Push to origin with auto-revert on failure
#   6. Release merge lock
#
# Return codes:
#   0 = success (merged + pushed)
#   1 = merge conflict (branch not merged)
#   2 = typecheck failed post-merge (reverted + pushed)
#   3 = critical failure (revert failed, main may be broken)
#   4 = merge lock contention (could not acquire)
#   5 = pull failed (could not update main)
#   6 = push failed post-merge (reverted + pushed)
#   7 = smoke test failed (reverted + pushed)

# do_merge_to_main — Merge a feature branch into main, typecheck, push.
#
# Arguments:
#   $1 = branch_name       — The feature branch to merge
#   $2 = worktree_dir      — The worktree dir to clean up (can be empty if already cleaned)
#   $3 = log_file          — Log file path (for git output redirection)
#   $4 = pre_lock_rebased  — "true" if pre-lock rebase succeeded, "false" otherwise
#
# Expects these globals from the sourcing script:
#   PROJECT_DIR, SKYNET_MAIN_BRANCH, SKYNET_POST_MERGE_TYPECHECK,
#   SKYNET_TYPECHECK_CMD, SKYNET_INSTALL_CMD, SKYNET_POST_MERGE_SMOKE,
#   SKYNET_SCRIPTS_DIR, MERGE_LOCK
#   Functions: log(), cleanup_worktree(), git_pull_with_retry(),
#              git_push_with_retry(), acquire_merge_lock(), release_merge_lock(),
#              file_mtime()
#
# On return, the caller is on $SKYNET_MAIN_BRANCH in $PROJECT_DIR.
# The merge lock is RELEASED before return in all cases.
# The branch is deleted on successful merge+push.
#
# The caller is responsible for:
#   - Pre-merge bookkeeping (state files, notifications)
#   - Post-merge bookkeeping based on the return code
#   - Script-specific state commits (git add/commit of state files)
#     must happen AFTER this function returns 0 (success) but before
#     the push — see _MERGE_NEEDS_PUSH flag.
#
# Advanced: State commit hook
#   If _MERGE_STATE_COMMIT_FN is set to a function name, do_merge_to_main()
#   will call it after a successful merge+typecheck but BEFORE pushing.
#   The function should return 0 on success. Its return value is stored in
#   _MERGE_STATE_COMMITTED (true/false) for revert accounting.

# Internal state shared with caller after return
_MERGE_STATE_COMMITTED=false

# _do_revert — Revert HEAD commit(s), optionally commit and push.
# Cross-ref: watchdog.sh canary revert uses git revert --no-edit --no-verify directly.
# Args: $1 = state_committed ("true" if state commit exists), $2 = reason, $3 = log_file
# When state_committed is "true", reverts HEAD (state) and HEAD~1 (merge).
# When "false", reverts only HEAD (the merge commit).
# Uses --no-commit so we can combine multiple reverts into one commit.
# Returns 0 on success, 1 on git revert failure.
_do_revert() {
  local state_committed="$1" reason="$2" log_file="$3"
  log "Reverting: $reason"
  if [ "$state_committed" = "true" ]; then
    # HEAD is state commit, HEAD~1 is merge — revert both
    if ! git revert --no-commit HEAD HEAD~1 2>>"$log_file"; then
      log "CRITICAL: git revert failed — main may be broken."
      return 1
    fi
  else
    if ! git revert --no-commit HEAD 2>>"$log_file"; then
      log "CRITICAL: git revert failed — main may be broken."
      return 1
    fi
  fi
  git commit -m "revert: auto-revert ($reason)" --no-verify 2>/dev/null || true
  return 0
}

do_merge_to_main() {
  local branch_name="$1"
  local worktree_dir="$2"
  local log_file="$3"
  local pre_lock_rebased="${4:-false}"

  _MERGE_STATE_COMMITTED=false

  # --- Pre-lock pull: fetch latest main before acquiring the merge lock ---
  # This reduces lock hold time because the post-lock pull will be a fast
  # no-op (or near-instant) if no other worker pushed in between.
  cd "$PROJECT_DIR"
  git pull --rebase origin "$SKYNET_MAIN_BRANCH" 2>/dev/null || true

  # --- Acquire merge mutex ---
  if ! acquire_merge_lock; then
    local _ml_holder=""
    [ -f "$MERGE_LOCK/pid" ] && _ml_holder=$(cat "$MERGE_LOCK/pid" 2>/dev/null || echo "unknown")
    log "Could not acquire merge lock — held by PID ${_ml_holder:-unknown}."
    return 4
  fi

  # --- Clean up worktree (keep branch for merge from main repo) ---
  if [ -n "$worktree_dir" ] && [ -d "$worktree_dir" ]; then
    cleanup_worktree
  fi
  cd "$PROJECT_DIR"

  # --- Pull latest main ---
  if ! git_pull_with_retry; then
    log "Cannot pull main — skipping merge."
    release_merge_lock
    return 5
  fi

  # --- Merge branch into main ---
  local _merge_succeeded=false

  # Save and disable ERR trap during merge attempts (merge failures are expected)
  local _saved_err_trap
  _saved_err_trap=$(trap -p ERR || true)
  trap - ERR
  set +e

  # Try fast-forward merge first (instant if pre-lock rebase succeeded)
  if [ "$pre_lock_rebased" = "true" ] && git merge "$branch_name" --ff-only 2>>"$log_file"; then
    _merge_succeeded=true
    log "Fast-forward merge succeeded (lock hold time minimized)."
  elif git merge "$branch_name" --no-edit 2>>"$log_file"; then
    _merge_succeeded=true
  else
    # Merge failed — attempt rebase recovery (max 1 attempt)
    log "Merge conflict — attempting rebase recovery..."
    git merge --abort 2>/dev/null || true
    git_pull_with_retry 2 || true
    # branch_name is sanitized by the caller (dev-worker.sh) to prevent leading hyphens
    if git checkout "$branch_name" 2>>"$log_file"; then
      if git rebase "$SKYNET_MAIN_BRANCH" 2>>"$log_file"; then
        log "Rebase succeeded — retrying merge."
        git checkout "$SKYNET_MAIN_BRANCH" 2>>"$log_file"
        if git merge "$branch_name" --no-edit 2>>"$log_file"; then
          _merge_succeeded=true
        else
          log "Merge still fails after successful rebase — conflict files: $(git diff --name-only --diff-filter=U 2>/dev/null | tr '\n' ' ')"
          git merge --abort 2>/dev/null || true
        fi
      else
        log "Rebase has conflicts — aborting. Conflict files: $(git diff --name-only --diff-filter=U 2>/dev/null | tr '\n' ' ')"
        git rebase --abort 2>/dev/null || true
        git checkout "$SKYNET_MAIN_BRANCH" 2>>"$log_file"
      fi
    else
      log "ERROR: Failed to checkout $branch_name for rebase recovery"
    fi
  fi

  set -e
  # Restore the caller's ERR trap. trap -p ERR returns a shell-escaped string
  # like `trap -- 'handler' ERR` which is safe to eval. We validate the prefix
  # to ensure no injection from corrupted trap output.
  # Safety: trap -p output is trusted (set by our own scripts), and the case
  # statement validates the prefix format before eval. This is safe within
  # the controlled execution environment of the pipeline.
  if [ -n "$_saved_err_trap" ]; then
    case "$_saved_err_trap" in
      "trap -- "*)  eval "$_saved_err_trap" ;;
      "trap -"*)    eval "$_saved_err_trap" ;;
      *)            echo "[WARN] Unexpected ERR trap format, skipping restore: $_saved_err_trap" >&2 ;;
    esac
  fi

  if ! $_merge_succeeded; then
    log "MERGE FAILED for $branch_name."
    release_merge_lock
    return 1
  fi

  # --- Post-merge typecheck gate (validates main still builds) ---
  if [ "${SKYNET_POST_MERGE_TYPECHECK:-true}" = "true" ]; then
    extend_merge_lock 2>/dev/null || true
    log "Running post-merge typecheck on main..."
    # Ensure deps are fresh if lock file changed in merge
    if [ -f "pnpm-lock.yaml" ] && [ -f "node_modules/.modules.yaml" ]; then
      local _lock_m _mods_m
      _lock_m=$(file_mtime "pnpm-lock.yaml")
      _mods_m=$(file_mtime "node_modules/.modules.yaml")
      if [ "$_lock_m" -gt "$_mods_m" ]; then
        log "Lock file newer than node_modules — installing before typecheck"
        local _install_cmd="${SKYNET_INSTALL_CMD:-pnpm install --frozen-lockfile}"
        # Validate install command against allowed character set (defense-in-depth)
        case "$_install_cmd" in
          *".."*|*";"*|*"|"*|*'$('*|*'`'*)
            log "ERROR: SKYNET_INSTALL_CMD contains disallowed characters — skipping install"
            ;;
          *)
            eval "$_install_cmd" >> "$log_file" 2>&1 || true
            ;;
        esac
      fi
    fi
    # Validate typecheck command before eval (defense-in-depth)
    local _tc_cmd="${SKYNET_TYPECHECK_CMD:-pnpm typecheck}"
    case "$_tc_cmd" in
      *".."*|*";"*|*"|"*|*'$('*|*'`'*)
        log "ERROR: SKYNET_TYPECHECK_CMD contains disallowed characters — failing typecheck"
        false
        ;;
    esac
    if ! eval "$_tc_cmd" >> "$log_file" 2>&1; then
      log "POST-MERGE TYPECHECK FAILED — reverting merge (holding merge lock)"
      if ! _do_revert "false" "typecheck failed" "$log_file"; then
        release_merge_lock
        return 3
      fi
      git_push_with_retry || log "WARNING: push of revert commit failed"
      release_merge_lock
      return 2
    fi
    log "Post-merge typecheck passed."
  fi

  # --- Delete merged branch ---
  git branch -d "$branch_name" 2>/dev/null || git branch -D "$branch_name" 2>/dev/null || true

  # --- State commit hook (caller-defined) ---
  if [ -n "${_MERGE_STATE_COMMIT_FN:-}" ] && declare -f "$_MERGE_STATE_COMMIT_FN" >/dev/null 2>&1; then
    if "$_MERGE_STATE_COMMIT_FN"; then
      _MERGE_STATE_COMMITTED=true
    else
      log "WARNING: State commit function failed — code merge will push without state update"
    fi
  fi

  # --- Post-merge smoke test (if enabled) ---
  if [ "${SKYNET_POST_MERGE_SMOKE:-false}" = "true" ]; then
    log "Running post-merge smoke test..."
    if ! bash "$SKYNET_SCRIPTS_DIR/post-merge-smoke.sh" >> "$log_file" 2>&1; then
      log "SMOKE TEST FAILED — reverting merge"
      if ! _do_revert "$_MERGE_STATE_COMMITTED" "smoke test failed" "$log_file"; then
        release_merge_lock
        return 3
      fi
      git_push_with_retry || log "WARNING: push of smoke test revert failed"
      release_merge_lock
      return 7
    fi
    log "Post-merge smoke test passed."
  fi

  # --- Push merged changes to origin (while still holding merge lock) ---
  # NOTE: If the process is killed between git commit and git push, an un-pushed
  # commit may be left on main. The watchdog detects this via commitsAhead > 0
  # and the next worker pull will incorporate the orphaned commit.
  extend_merge_lock 2>/dev/null || true
  if ! git_push_with_retry; then
    log "PUSH FAILED after merge — reverting to prevent split-brain"
    if ! _do_revert "$_MERGE_STATE_COMMITTED" "push failed" "$log_file"; then
      release_merge_lock
      return 3
    fi
    # Try to push the revert
    if ! git_push_with_retry; then
      log "CRITICAL: revert push also failed — local main diverged from remote."
      emit_event "push_diverged" "Force-syncing to origin/main after push failure" || true
      log "CRITICAL: Push failed after revert — force-syncing local main to origin"
      # RECOVERY: Hard reset to remote state after push failure.
      # This is intentional — when both push and revert-push fail, local main
      # has diverged from remote. Resetting to origin ensures consistency.
      # Any merged code that couldn't be pushed will be retried by the worker.
      # The watchdog's next cycle will detect and handle any main-branch issues.
      git fetch origin "$SKYNET_MAIN_BRANCH" 2>>"$log_file" && git reset --hard "origin/$SKYNET_MAIN_BRANCH" 2>>"$log_file" || true
      release_merge_lock
      return 3
    fi
    release_merge_lock
    return 6
  fi

  # Canary detection: if scripts/*.sh files changed, write canary-pending
  if [ "${SKYNET_CANARY_ENABLED:-false}" = "true" ]; then
    local _canary_changed
    _canary_changed=$(git diff --name-only HEAD~1..HEAD -- 'scripts/*.sh' 2>/dev/null || echo "")
    if [ -n "$_canary_changed" ]; then
      local _canary_file="${DEV_DIR}/canary-pending"
      {
        echo "commit=$(git rev-parse HEAD)"
        echo "timestamp=$(date +%s)"
        echo "files=$_canary_changed"
      } > "$_canary_file"
      log "CANARY: Script changes detected — canary mode activated"
      log "CANARY: Changed files: $_canary_changed"
    fi
  fi

  release_merge_lock
  return 0
}
