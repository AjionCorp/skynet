# Current Task
## [FIX] Make worker-scaling handler read `SKYNET_MAX_FIXERS` from config instead of hardcoding 3 — in `packages/dashboard/src/handlers/worker-scaling.ts` lines 16-18, `TYPE_MAX` hardcodes `"task-fixer": 3`. If a user sets `SKYNET_MAX_FIXERS=5` in config, the dashboard scaling UI still caps at 3 fixers, which is misleading. Fix: (1) add `maxFixers?: number` to the `SkynetConfig` interface in `packages/dashboard/src/types.ts` (after `maxWorkers`). (2) In `maxForType()`, handle `"task-fixer"` dynamically: `if (t === "task-fixer") return maxFixers;`. (3) In the admin API route `packages/admin/src/app/api/admin/workers/scale/route.ts`, read `SKYNET_MAX_FIXERS` from config and pass it to the handler. Run `pnpm typecheck`. Criterion #4 (dashboard must reflect actual configuration)
**Status:** completed
**Started:** 2026-02-20 02:06
**Completed:** 2026-02-20
**Branch:** dev/make-worker-scaling-handler-read-skynetm
**Worker:** 3

### Changes
-- See git log for details
