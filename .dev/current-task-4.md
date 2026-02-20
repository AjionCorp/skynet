# Current Task
## [FIX] Fix `skynet stop` and `skynet doctor` hardcoded worker lists — in `packages/cli/src/commands/stop.ts` line 99, workers are hardcoded as `["dev-worker-1", "dev-worker-2", "task-fixer", "project-driver", ...]`. When `SKYNET_MAX_WORKERS=4`, workers 3-4 are silently left running by `skynet stop`. Same issue in `packages/cli/src/commands/doctor.ts` line 213-214 which hardcodes the same 2-worker list. Fix: (1) In `stop.ts`, read `SKYNET_MAX_WORKERS` and `SKYNET_MAX_FIXERS` from config via `loadConfig()`, then dynamically build the worker list: `for (let i = 1; i <= maxWorkers; i++) workers.push("dev-worker-" + i)` and `for (let i = 1; i <= maxFixers; i++) workers.push("task-fixer-" + i)`. (2) In `doctor.ts`, apply the same dynamic pattern for the Workers section at line 213. Also add stale lock cleanup to `--fix` mode: when a stale lock directory is detected (PID not alive), `rmdirSync`/`rmSync` the lock directory. Run `pnpm typecheck`. Criterion #1 (correct CLI behavior at all scale configurations) and #3 (reliable stop)
**Status:** completed
**Started:** 2026-02-20 02:20
**Completed:** 2026-02-20
**Branch:** dev/fix-skynet-stop-and-skynet-doctor-hardco
**Worker:** 4

### Changes
-- See git log for details
