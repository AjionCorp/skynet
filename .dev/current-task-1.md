# Current Task
## [FIX] Fix task POST handler to retry lock acquisition instead of immediate 423 failure — in `packages/dashboard/src/handlers/tasks.ts` lines 143-150, lock acquisition uses a single `mkdirSync(backlogLockPath)` with zero retry. If a shell worker holds the lock (even for 100ms during a claim), the dashboard API immediately returns HTTP 423 to the user. Shell scripts retry 50 times at 100ms intervals (5 seconds total). Fix: wrap the `mkdirSync` in an async retry loop: try up to 30 times with 100ms delay between attempts (`await new Promise(r => setTimeout(r, 100))`). If all retries fail, return 423 as before. Run `pnpm typecheck`. Criterion #4 (dashboard operations must actually work — adding tasks from the UI should not fail during normal pipeline activity)
**Status:** completed
**Started:** 2026-02-20 03:23
**Completed:** 2026-02-20
**Branch:** dev/fix-task-post-handler-to-retry-lock-acqu
**Worker:** 1

### Changes
-- See git log for details
