# Current Task
## [FEAT] Add graceful shutdown signal handling to dev-worker.sh and task-fixer.sh — in `scripts/dev-worker.sh`, add `trap 'SHUTDOWN_REQUESTED=true' SIGTERM SIGINT` near the top (after PID lock acquisition). Before the main `claim_next_task` call (~line 80), check `if $SHUTDOWN_REQUESTED; then log "Shutdown requested, exiting cleanly"; exit 0; fi`. After the agent finishes execution but before `git merge` (~line 200), check again — if set, run `unclaim_task "$TASK_TITLE"`, cleanup worktree, and exit. Apply the same pattern to `scripts/task-fixer.sh` before its fix attempt loop. This prevents mid-merge kills from `skynet stop` leaving branches in inconsistent state, directly improving mission criterion #3 (no lost tasks)
**Status:** completed
**Started:** 2026-02-19 17:34
**Completed:** 2026-02-19
**Branch:** dev/add-graceful-shutdown-signal-handling-to
**Worker:** 2

### Changes
-- See git log for details
