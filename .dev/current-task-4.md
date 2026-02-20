# Current Task
## [FIX] Add backlog mutex lock to CLI `add-task` and `reset-task` commands to prevent data corruption — in `packages/cli/src/commands/add-task.ts` lines 46-89, `backlog.md` is read, modified, and written using atomic rename but WITHOUT acquiring the backlog mutex lock (`${SKYNET_LOCK_PREFIX}-backlog.lock`). Shell workers hold this lock during all backlog modifications. Concurrent `skynet add-task` and a worker claiming a task can corrupt `backlog.md` (lost writes). Same issue in `packages/cli/src/commands/reset-task.ts` which writes both `backlog.md` and `failed-tasks.md` without any lock at lines 124 and 140. Fix: (1) Create a shared `acquireBacklogLock(lockPath: string, retries?: number, intervalMs?: number): boolean` utility in `packages/cli/src/utils/backlogLock.ts`. (2) In `add-task.ts`, before reading backlog.md, acquire lock; release in a try/finally with `rmSync(lockPath, { recursive: true })`. (3) Apply same pattern to `reset-task.ts`. Derive lock path as `${lockPrefix}-backlog.lock` where lockPrefix comes from config. Run `pnpm typecheck`. Criterion #3 (data integrity — no backlog corruption under concurrent access)
**Status:** completed
**Started:** 2026-02-20 03:20
**Completed:** 2026-02-20
**Branch:** dev/add-backlog-mutex-lock-to-cli-add-task-a
**Worker:** 4

### Changes
-- See git log for details
