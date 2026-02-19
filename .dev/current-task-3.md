# Current Task
## [FEAT] Add log viewer page to admin dashboard for live log viewing — create `packages/admin/src/app/admin/logs/page.tsx` that imports a new `LogViewer` component from `@ajioncorp/skynet/components`. Create `packages/dashboard/src/components/LogViewer.tsx` — renders a dropdown to select log type (worker-1..N, fixer-1..N, watchdog, health-check, project-driver), fetches last 200 lines from `/api/admin/monitoring/logs?type=<selected>`, displays in a scrollable `<pre>` with monospace font and auto-scroll-to-bottom. Add auto-refresh toggle (5s polling). Add navigation entry in layout.tsx: `{ href: "/admin/logs", label: "Logs", icon: ScrollText }` (import from lucide-react). Export `LogViewer` from `packages/dashboard/src/components/index.ts`. Criterion #4 — logs currently only viewable via CLI
**Status:** completed
**Started:** 2026-02-19 17:55
**Completed:** 2026-02-19
**Branch:** dev/add-log-viewer-page-to-admin-dashboard-f
**Worker:** 3

### Changes
-- See git log for details
