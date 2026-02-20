# Current Task
## [FIX] Make LogViewer worker/fixer count dynamic instead of hardcoded — in `packages/dashboard/src/components/LogViewer.tsx` lines 8-19, `LOG_SOURCES` is a hardcoded array with exactly 4 worker entries and 3 fixer entries. If `SKYNET_MAX_WORKERS` or `SKYNET_MAX_FIXERS` is configured higher, those workers' logs are invisible in the dashboard. Fix: change `LOG_SOURCES` from a static const to a function `getLogSources(maxWorkers: number, maxFixers: number)` that generates entries dynamically. Fetch `maxWorkers` and `maxFixers` from the config API endpoint (`/api/admin/config`) on component mount, defaulting to 4 workers and 3 fixers if the API is unavailable. Run `pnpm typecheck`. Criterion #4 (dashboard visibility scales with configuration)
**Status:** completed
**Started:** 2026-02-20 01:48
**Completed:** 2026-02-20
**Branch:** dev/make-logviewer-workerfixer-count-dynamic
**Worker:** 1

### Changes
-- See git log for details
