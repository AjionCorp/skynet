# Current Task
## [FIX] Harden task-fixer.sh EXIT trap for mid-merge crash safety — current EXIT trap in task-fixer.sh is minimal. If the script crashes during `git merge` or `git push`, the task remains claimed and the branch is orphaned. Add a full `cleanup_on_exit` function (matching dev-worker.sh pattern): unclaim task in backlog.md via `unclaim_task()`, remove worktree via `git worktree remove --force`, release PID lock, stop any background processes, and log the crash event
**Status:** completed
**Started:** 2026-02-19 15:10
**Completed:** 2026-02-19
**Branch:** dev/harden-task-fixersh-exit-trap-for-mid-me
**Worker:** 2

### Changes
-- See git log for details
