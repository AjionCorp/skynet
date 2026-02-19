# Current Task
## [FEAT] Add dynamic worker scaling from admin dashboard — add a "Scale Workers" section to the admin monitoring page with +/- buttons per worker type (dev-worker, task-fixer, project-driver). Backend: create POST /api/admin/workers/scale handler in packages/dashboard/src/handlers/ that accepts `{ workerType, count }`, spawns or kills worker processes by invoking the corresponding script via `child_process.spawn()` with proper PID tracking. Frontend: add WorkerScaling component showing current active count per type with increment/decrement controls. Must handle: PID file cleanup on scale-down, heartbeat registration on scale-up, max worker limit from config
**Status:** completed
**Started:** 2026-02-19 15:25
**Completed:** 2026-02-19
**Branch:** dev/add-dynamic-worker-scaling-from-admin-da
**Worker:** 2

### Changes
-- See git log for details
