# Current Task
## [FIX] Add `git pull` before first merge attempt in dev-worker.sh and task-fixer.sh to reduce unnecessary conflicts — in `scripts/dev-worker.sh` lines 588-591, the first merge attempt goes directly to `git merge "$branch_name" --no-edit` without pulling the latest `main`. With 4 concurrent workers, `main` advances between branch creation and merge time. The `git pull` only happens in the rebase recovery path at line 597, meaning every concurrent merge conflicts first, then recovers — wasting 10-30 seconds per task. Fix: add `git pull origin "$SKYNET_MAIN_BRANCH" 2>>"$LOG" || true` between lines 588 and 590 (after `cd "$PROJECT_DIR"`, before the first `git merge`). Apply the same fix in `scripts/task-fixer.sh` before its merge attempt at line 445. Run `bash -n` on both files and `pnpm typecheck`. Criterion #3 (reliability — proactively prevent merge conflicts instead of recovering from them)
**Status:** completed
**Started:** 2026-02-20 03:19
**Completed:** 2026-02-20
**Branch:** dev/add-git-pull-before-first-merge-attempt-
**Worker:** 3

### Changes
-- See git log for details
