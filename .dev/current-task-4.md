# Current Task
## [TEST] Add worker-scaling handler unit tests — create `packages/dashboard/src/handlers/worker-scaling.test.ts`. Test cases: (1) GET returns current worker counts by type with correct `WorkerScaleInfo[]` shape, (2) POST scale-up returns correct `WorkerScaleResult`, (3) POST scale-down cleans PID files, (4) max worker limit enforced (returns 400 if count exceeds `maxCount`), (5) invalid worker type returns 400, (6) scale to same count is a no-op, (7) handles missing PID files gracefully, (8) concurrent scale requests don't corrupt state. Mock `child_process.spawn` and `fs` operations. Follow patterns from existing tests in `packages/dashboard/src/handlers/*.test.ts`
**Status:** completed
**Started:** 2026-02-19 17:22
**Completed:** 2026-02-19
**Branch:** dev/add-worker-scaling-handler-unit-tests--c
**Worker:** 4

### Changes
-- See git log for details
