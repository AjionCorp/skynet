# Current Task
## [FIX] Wire WorkerScaling component into admin dashboard navigation and add dedicated workers page — in `packages/admin/src/app/admin/layout.tsx`, add a navigation entry: `{ href: "/admin/workers", label: "Workers", icon: Users }` (import `Users` from lucide-react). Create `packages/admin/src/app/admin/workers/page.tsx` that imports `WorkerScaling` from `@ajioncorp/skynet/components` and wraps it in the page layout with `ErrorBoundary` and `Suspense`. The API route `packages/admin/src/app/api/admin/workers/scale/route.ts` already exists. The `WorkerScaling` component is exported from the dashboard package but currently unreachable via any admin page — this directly addresses criterion #4 (full dashboard visibility)
**Status:** completed
**Started:** 2026-02-19 17:51
**Completed:** 2026-02-19
**Branch:** dev/wire-workerscaling-component-into-admin-
**Worker:** 3

### Changes
-- See git log for details
