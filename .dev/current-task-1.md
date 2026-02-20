# Current Task
## [FIX] Fix TypeScript backlog mutex path missing dash separator — in `packages/dashboard/src/handlers/tasks.ts` line 85, `backlogLockPath` is constructed as `${lockPrefix}backlog.lock` (no dash), producing `/tmp/skynet-skynetbacklog.lock`. But bash scripts use `${SKYNET_LOCK_PREFIX}-backlog.lock` (with dash), producing `/tmp/skynet-skynet-backlog.lock`. The dashboard and workers can NEVER contend on the same mutex — concurrent writes from the dashboard POST `/api/admin/tasks` and a shell worker can corrupt `backlog.md`. Same missing-dash issue in `pipeline-status.ts` lines 422-423 (`${lockPrefix}claude-token` and `${lockPrefix}auth-failed` — both missing the dash). Fix: in `tasks.ts:85`, change to `${lockPrefix}-backlog.lock`. In `pipeline-status.ts:422-423`, change to `${lockPrefix}-claude-token` and `${lockPrefix}-auth-failed`. In `pipeline-status.ts:447`, change to `${lockPrefix}-backlog.lock`. Run `pnpm typecheck`. Criterion #3 (data integrity — backlog.md corruption prevention)
**Status:** completed
**Started:** 2026-02-20 02:19
**Completed:** 2026-02-20
**Branch:** dev/fix-typescript-backlog-mutex-path-missin
**Worker:** 1

### Changes
-- See git log for details
