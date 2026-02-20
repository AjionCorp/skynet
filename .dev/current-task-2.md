# Current Task
## [FIX] Fix dashboard typecheck — 35 fetch mock type errors blocking all worker merges — `pnpm typecheck` fails with TS2741 ("Property 'preconnect' is missing") and TS2352 (fetch-to-Mock cast error) in 13 dashboard component test files: `ActivityFeed.test.tsx`, `EventsDashboard.test.tsx`, `LogViewer.test.tsx`, `MissionDashboard.test.tsx`, `MonitoringDashboard.test.tsx`, `PipelineDashboard.test.tsx`, `PromptsDashboard.test.tsx`, `SettingsDashboard.test.tsx`, `SyncDashboard.test.tsx`, `TasksDashboard.test.tsx`, `WorkerScaling.test.tsx`. All errors come from `global.fetch = vi.fn().mockResolvedValue(...)` where the mock lacks the `preconnect` property added in newer Node.js/undici types. Fix: in each test file's `mockFetchWith()` or `beforeEach` block, replace direct `global.fetch = vi.fn()...` assignment with `vi.stubGlobal('fetch', vi.fn().mockResolvedValue(...))` which bypasses the type check on assignment. For places that cast `global.fetch as Mock`, change to `vi.mocked(global.fetch)`. Run `pnpm typecheck` — must exit cleanly. Criterion #2 (typecheck is the quality gate — 0 errors required for any worker to merge)
**Status:** completed
**Started:** 2026-02-20 03:17
**Completed:** 2026-02-20
**Branch:** dev/fix-dashboard-typecheck--35-fetch-mock-t
**Worker:** 2

### Changes
-- See git log for details
