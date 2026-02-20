# Current Task
## [FIX] Add merge retry with rebase to task-fixer.sh — `scripts/task-fixer.sh` line 427 does a bare `git merge "$branch_name" --no-edit` with NO recovery on failure. Unlike `dev-worker.sh` (lines 555-576) which has full merge-abort → git-pull → rebase → retry logic, the task-fixer immediately gives up on merge conflicts. Since fixers run on branches that have already diverged from main (the original worker failed, main has moved), merge conflicts are very common for fixer attempts. Fix: after line 427, add the same recovery block as `dev-worker.sh:555-576`: `git merge --abort`, `git pull origin main`, `git checkout "$branch_name"`, `git rebase main`, if rebase succeeds retry merge once. If rebase has conflicts, `git rebase --abort` and proceed to fail. Log "Merge conflict — attempting rebase recovery..." for visibility. Run `pnpm typecheck`. Criterion #2 (self-correction rate improvement — fixer merge failures are the #1 remaining failure mode)
**Status:** completed
**Started:** 2026-02-20 01:42
**Completed:** 2026-02-20
**Branch:** dev/add-merge-retry-with-rebase-to-task-fixe
**Worker:** 4

### Changes
-- See git log for details
