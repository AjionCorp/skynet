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

# OPS-P1-2: Merge lock acquisition timestamp (set inside do_merge_to_main).
# Uses SECONDS delta (not wall-clock) — captures baseline at lock acquisition
# and computes elapsed = SECONDS - baseline, which is correct regardless of
# total shell uptime.
_MERGE_LOCK_ACQUIRED_AT=-1

# OPS-R21-P1-1: Compute dynamic merge lock TTL based on last known typecheck duration.
# When typecheck takes >300s, the default 900s TTL may expire before push completes.
# Reads the last duration from .dev/typecheck-duration, computes TTL = max(900, dur*2+300),
# and caps at 1800s (30 min absolute max).
_compute_dynamic_merge_ttl() {
  local _tc_dur_file="${DEV_DIR}/typecheck-duration"
  local _base_ttl="${SKYNET_MERGE_LOCK_TTL:-900}"
  if [ -f "$_tc_dur_file" ]; then
    local _last_dur
    _last_dur=$(cat "$_tc_dur_file" 2>/dev/null || echo "0")
    # Validate numeric
    case "$_last_dur" in
      ''|*[!0-9]*) _last_dur=0 ;;
    esac
    if [ "$_last_dur" -gt 300 ]; then
      local _dynamic_ttl=$(( _last_dur * 2 + 300 ))
      # Floor: at least the configured TTL
      if [ "$_dynamic_ttl" -lt "$_base_ttl" ]; then
        _dynamic_ttl="$_base_ttl"
      fi
      # Cap: 1800s absolute max
      if [ "$_dynamic_ttl" -gt 1800 ]; then
        _dynamic_ttl=1800
      fi
      log "Dynamic merge TTL: ${_dynamic_ttl}s (last typecheck ${_last_dur}s, base TTL ${_base_ttl}s)"
      SKYNET_MERGE_LOCK_TTL="$_dynamic_ttl"
    fi
  fi
}

# SH-P1-3: Check remaining TTL before each major merge operation.
# Returns 0 if at least $1 seconds (default 180) remain, 1 if insufficient.
_check_merge_lock_ttl() {
  local _min_remaining="${1:-180}"
  if [ "$_MERGE_LOCK_ACQUIRED_AT" -lt 0 ] 2>/dev/null; then
    # Lock not acquired — cannot check TTL
    return 1
  fi
  local _lock_age=$(( SECONDS - _MERGE_LOCK_ACQUIRED_AT ))
  local _remaining=$(( SKYNET_MERGE_LOCK_TTL - _lock_age ))
  if [ "$_remaining" -lt "$_min_remaining" ]; then
    log "ERROR: Merge lock TTL insufficient — ${_remaining}s remaining (need ${_min_remaining}s). Lock held for ${_lock_age}s of ${SKYNET_MERGE_LOCK_TTL}s TTL."
    return 1
  fi
  return 0
}
# P1-1: Merge-aware push with TTL guard before each attempt.
# Wraps git_push_with_retry logic but checks merge lock TTL (120s minimum)
# immediately before each push attempt to prevent split-brain when TTL expires
# during a network stall. 120s is enough for one push attempt under normal
# conditions (push timeout defaults to 120s).
_merge_push_with_ttl_guard() {
  local max_attempts="${1:-3}"
  local attempt=1
  local backoff=1

  # Reuse adaptive push timeout logic from git_push_with_retry
  local _push_timeout="$SKYNET_GIT_PUSH_TIMEOUT"
  local _diff_lines=0
  local _diff_stat
  _diff_stat=$(git diff --stat --cached 2>/dev/null | tail -1)
  if [ -n "$_diff_stat" ]; then
    local _insertions _deletions
    _insertions=$(printf '%s' "$_diff_stat" | sed -n 's/.*[[:space:]]\([0-9][0-9]*\) insertion.*/\1/p')
    _deletions=$(printf '%s' "$_diff_stat" | sed -n 's/.*[[:space:]]\([0-9][0-9]*\) deletion.*/\1/p')
    _diff_lines=$(( ${_insertions:-0} + ${_deletions:-0} ))
  fi
  if [ "$_diff_lines" -gt 5000 ]; then
    _push_timeout=$(( SKYNET_GIT_PUSH_TIMEOUT * 2 ))
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
    # P1-1: TTL check before every push attempt (including the first).
    # Require 120s remaining — enough for one push attempt to complete.
    if ! _check_merge_lock_ttl 120; then
      log "ERROR: Merge lock TTL exhausted before push attempt $attempt — aborting to prevent split-brain"
      return 1
    fi
    [ "$attempt" -gt 1 ] && log "git push attempt $attempt/$max_attempts (TTL-guarded)..."
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

# OPS-P1-2: Release merge lock with duration logging
_release_merge_lock_with_duration() {
  local duration
  if [ "$_MERGE_LOCK_ACQUIRED_AT" -ge 0 ] 2>/dev/null; then
    duration=$(( SECONDS - _MERGE_LOCK_ACQUIRED_AT ))
  else
    # Lock was never acquired (safety fallback) — report unknown duration
    duration=-1
  fi
  release_merge_lock
  if [ "$duration" -ge 0 ]; then
    log "Merge lock held for ${duration}s"
    if [ "$duration" -gt 300 ]; then
      log "WARNING: Merge lock held for ${duration}s (>300s threshold)"
    fi
  else
    log "WARNING: Merge lock released but acquisition timestamp was not recorded"
  fi
  _MERGE_LOCK_ACQUIRED_AT=-1
}

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
      # SH-P3-1: Clean up partial revert state so the working tree is not
      # left dirty (half-applied revert). reset --hard restores HEAD cleanly.
      git reset --hard HEAD 2>/dev/null || true
      return 1
    fi
  else
    if ! git revert --no-commit HEAD 2>>"$log_file"; then
      log "CRITICAL: git revert failed — main may be broken."
      # SH-P3-1: Clean up partial revert state (see above).
      git reset --hard HEAD 2>/dev/null || true
      return 1
    fi
  fi
  # --no-verify skips pre-commit hooks intentionally: revert commits are
  # auto-generated emergency rollbacks and must not be blocked by linters
  # or typecheck hooks that may themselves fail on the reverted code.
  if ! git commit -m "revert: auto-revert ($reason)" --no-verify 2>/dev/null; then
    log "CRITICAL: git commit for revert failed"
    return 1
  fi
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
  # NOTE: No --rebase flag — rebase can rewrite commits and cause issues
  # when multiple workers are merging concurrently.
  cd "$PROJECT_DIR"
  git pull origin "$SKYNET_MAIN_BRANCH" 2>/dev/null || true

  # --- Compute dynamic TTL (OPS-R21-P1-1) ---
  _compute_dynamic_merge_ttl

  # --- Acquire merge mutex ---
  if ! acquire_merge_lock; then
    local _ml_holder=""
    [ -f "$MERGE_LOCK/pid" ] && _ml_holder=$(cat "$MERGE_LOCK/pid" 2>/dev/null || echo "unknown")
    log "Could not acquire merge lock — held by PID ${_ml_holder:-unknown}."
    return 4
  fi
  # OPS-P2-3: Record lock acquisition time to log hold duration at release
  _MERGE_LOCK_ACQUIRED_AT=$SECONDS

  # --- Clean up worktree (keep branch for merge from main repo) ---
  # OPS-P2-7: Worktree cleanup happens AFTER acquiring the merge lock but BEFORE
  # the merge itself. This is safe because: (1) the branch ref is preserved — only
  # the worktree directory is removed, (2) the merge operates on refs from the main
  # repo (PROJECT_DIR), not the worktree, (3) cleaning before merge avoids leaving
  # an orphaned worktree if the merge fails or the process is killed mid-merge.
  if [ -n "$worktree_dir" ] && [ -d "$worktree_dir" ]; then
    cleanup_worktree
  fi
  cd "$PROJECT_DIR"

  # --- Pull latest main ---
  if ! git_pull_with_retry; then
    log "Cannot pull main — skipping merge."
    _release_merge_lock_with_duration
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
    run_with_timeout "${SKYNET_GIT_TIMEOUT:-120}" git merge --abort 2>/dev/null || true
    git_pull_with_retry 2 || true
    # branch_name is sanitized by the caller (dev-worker.sh) to prevent leading hyphens
    if run_with_timeout "${SKYNET_GIT_TIMEOUT:-120}" git checkout "$branch_name" 2>>"$log_file"; then
      if run_with_timeout "${SKYNET_GIT_TIMEOUT:-120}" git rebase "$SKYNET_MAIN_BRANCH" 2>>"$log_file"; then
        log "Rebase succeeded — retrying merge."
        run_with_timeout "${SKYNET_GIT_TIMEOUT:-120}" git checkout "$SKYNET_MAIN_BRANCH" 2>>"$log_file"
        if git merge "$branch_name" --no-edit 2>>"$log_file"; then
          _merge_succeeded=true
        else
          log "Merge still fails after successful rebase — conflict files: $(git diff --name-only --diff-filter=U 2>/dev/null | tr '\n' ' ')"
          run_with_timeout "${SKYNET_GIT_TIMEOUT:-120}" git merge --abort 2>/dev/null || true
        fi
      else
        log "Rebase has conflicts — aborting. Conflict files: $(git diff --name-only --diff-filter=U 2>/dev/null | tr '\n' ' ')"
        run_with_timeout "${SKYNET_GIT_TIMEOUT:-120}" git rebase --abort 2>/dev/null || true
        run_with_timeout "${SKYNET_GIT_TIMEOUT:-120}" git checkout "$SKYNET_MAIN_BRANCH" 2>>"$log_file"
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
    _release_merge_lock_with_duration
    return 1
  fi

  # --- Post-merge typecheck gate (validates main still builds) ---
  if [ "${SKYNET_POST_MERGE_TYPECHECK:-true}" = "true" ]; then
    # SH-P1-3: Verify sufficient TTL before starting typecheck (can take 5+ minutes)
    if ! _check_merge_lock_ttl 180; then
      log "ERROR: Insufficient merge lock TTL before typecheck — aborting merge"
      _release_merge_lock_with_duration
      return 3
    fi
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
    local _tc_cmd_valid=true
    case "$_tc_cmd" in
      *".."*|*";"*|*"|"*|*'$('*|*'`'*)
        log "ERROR: SKYNET_TYPECHECK_CMD contains disallowed characters — failing typecheck"
        _tc_cmd_valid=false
        ;;
    esac
    local _tc_start_seconds=$SECONDS
    if ! $_tc_cmd_valid || ! eval "$_tc_cmd" >> "$log_file" 2>&1; then
      # OPS-R21-P1-1: Write typecheck duration even on failure (for future TTL computation)
      local _tc_elapsed=$(( SECONDS - _tc_start_seconds ))
      echo "$_tc_elapsed" > "${DEV_DIR}/typecheck-duration" 2>/dev/null || true
      log "POST-MERGE TYPECHECK FAILED — reverting merge (holding merge lock)"
      if ! _do_revert "false" "typecheck failed" "$log_file"; then
        _release_merge_lock_with_duration
        return 3
      fi
      # SH-P1-3: Check TTL before pushing revert
      if ! _check_merge_lock_ttl 180; then
        log "WARNING: Insufficient TTL for revert push — releasing lock without push"
        _release_merge_lock_with_duration
        return 3
      fi
      git_push_with_retry || log "WARNING: push of revert commit failed"
      _release_merge_lock_with_duration
      return 2
    fi
    # OPS-R21-P1-1: Write typecheck duration for future dynamic TTL computation
    local _tc_elapsed=$(( SECONDS - _tc_start_seconds ))
    echo "$_tc_elapsed" > "${DEV_DIR}/typecheck-duration" 2>/dev/null || true
    log "Post-merge typecheck passed (${_tc_elapsed}s)."
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
        _release_merge_lock_with_duration
        return 3
      fi
      # SH-P1-3: Check TTL before pushing smoke test revert
      if ! _check_merge_lock_ttl 180; then
        log "WARNING: Insufficient TTL for smoke revert push — releasing lock without push"
        _release_merge_lock_with_duration
        return 3
      fi
      git_push_with_retry || log "WARNING: push of smoke test revert failed"
      _release_merge_lock_with_duration
      return 7
    fi
    log "Post-merge smoke test passed."
  fi

  # --- Push merged changes to origin (while still holding merge lock) ---
  # NOTE: If the process is killed between git commit and git push, an un-pushed
  # commit may be left on main. The watchdog detects this via commitsAhead > 0
  # and the next worker pull will incorporate the orphaned commit.
  extend_merge_lock 2>/dev/null || true

  # OPS-P0-1: Warn if merge lock has been held for > 500s (approaching TTL)
  if [ -f "$MERGE_LOCK/pid" ]; then
    local _lock_mtime _lock_elapsed
    if [ "$(uname -s)" = "Darwin" ]; then
      _lock_mtime=$(stat -f %m "$MERGE_LOCK/pid" 2>/dev/null || echo 0)
    else
      _lock_mtime=$(stat -c %Y "$MERGE_LOCK/pid" 2>/dev/null || echo 0)
    fi
    _lock_elapsed=$(( $(date +%s) - _lock_mtime ))
    if [ "$_lock_elapsed" -gt 500 ]; then
      log "WARNING: Merge lock held for ${_lock_elapsed}s (TTL=${SKYNET_MERGE_LOCK_TTL}s) — push may race against TTL expiry"
    fi
  fi

  # OPS-P1-4: Abort if insufficient TTL remaining for a safe push (need 180s margin)
  local _lock_age=$(( SECONDS - _MERGE_LOCK_ACQUIRED_AT ))
  if [ "$_lock_age" -gt $(( SKYNET_MERGE_LOCK_TTL - 180 )) ]; then
    log "ERROR: Merge lock held for ${_lock_age}s — insufficient TTL remaining for push (need 180s). Aborting."
    _release_merge_lock_with_duration
    return 3
  fi

  # P1-1: Final TTL re-check immediately before push — require 120s remaining.
  # This closes the window between OPS-P1-4 check above and the actual push,
  # preventing split-brain if intervening operations consumed remaining TTL.
  if ! _check_merge_lock_ttl 120; then
    log "ERROR: Merge lock TTL insufficient immediately before push — aborting to prevent split-brain"
    _release_merge_lock_with_duration
    return 3
  fi

  if ! _merge_push_with_ttl_guard; then
    log "PUSH FAILED after merge — reverting to prevent split-brain"
    if ! _do_revert "$_MERGE_STATE_COMMITTED" "push failed" "$log_file"; then
      _release_merge_lock_with_duration
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
      #
      # OPS-P1-2: RISK SCENARIO — In an extreme edge case, if the merge lock TTL
      # expired during a push timeout, another worker could have acquired the lock,
      # merged, and pushed its own commit to main. A subsequent `git pull` would
      # incorporate that commit into local main. The `git reset --hard` below would
      # then discard that worker's commit from local main. This is acceptable because:
      #   1. The commit exists on origin (it was pushed by the other worker).
      #   2. Local main is a throwaway recovery state at this point.
      #   3. The next pull will re-incorporate the other worker's commit.
      # The hard reset is the last-resort recovery — do NOT remove it.
      log "WARNING: Executing git reset --hard to origin/$SKYNET_MAIN_BRANCH — local unpushed commits (if any) will be discarded. This is last-resort recovery after double push failure."
      git fetch origin "$SKYNET_MAIN_BRANCH" 2>>"$log_file" && git reset --hard "origin/$SKYNET_MAIN_BRANCH" 2>>"$log_file" || true
      _release_merge_lock_with_duration
      return 3
    fi
    _release_merge_lock_with_duration
    return 6
  fi

  # Canary detection: if scripts/*.sh files changed, write canary-pending
  if [ "${SKYNET_CANARY_ENABLED:-false}" = "true" ]; then
    local _canary_changed
    _canary_changed=$(git diff --name-only HEAD~1..HEAD -- 'scripts/*.sh' 'scripts/agents/*.sh' 'scripts/lock-backends/*.sh' 'scripts/notify/*.sh' 2>/dev/null || echo "")
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

  _release_merge_lock_with_duration
  return 0
}
