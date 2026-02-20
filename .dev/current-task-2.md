# Current Task
## [FIX] Fix worker-scaling handler using `unlinkSync` on directory-based lock files — in `packages/dashboard/src/handlers/worker-scaling.ts` line 238, `unlinkSync(instance.lockFile)` attempts to delete the lock as a file, but all workers now use mkdir-based locks where `lockFile` is a directory containing a `pid` file. `unlinkSync` throws `EISDIR` on directories, which is silently swallowed by the catch block at line 239. Scale-down operations never clean up lock directories, leaving stale locks that cause `skynet doctor`, `status`, and `stop` to report phantom running workers. Fix: change line 238 from `unlinkSync(instance.lockFile)` to `rmSync(instance.lockFile, { recursive: true, force: true })`. Import `rmSync` from `fs` if not already imported. This matches the pattern already used correctly in `packages/cli/src/commands/stop.ts` line 42. Run `pnpm typecheck`. Criterion #3 (reliable scale-down — no stale locks) and Criterion #4 (dashboard operations must actually work)
**Status:** completed
**Started:** 2026-02-20 02:47
**Completed:** 2026-02-20
**Branch:** dev/fix-worker-scaling-handler-using-unlinks
**Worker:** 2

### Changes
-- See git log for details
