# Current Task
## [FIX] Fix duplicate Activity icon for events page in admin navigation — in `packages/admin/src/app/admin/layout.tsx`, both `pipeline` (line 9) and `events` (line 17) use the `Activity` icon from lucide-react. This makes the sidebar navigation confusing — two identical icons for different pages. Fix: change the `events` entry to use the `ScrollText` icon (or `FileText`/`ListOrdered`), which better represents an event log/audit trail. Import `ScrollText` from `lucide-react` and update the icon property. Run `pnpm typecheck`. Criterion #4 (dashboard usability — distinct visual navigation)
**Status:** completed
**Started:** 2026-02-20 02:23
**Completed:** 2026-02-20
**Branch:** dev/fix-duplicate-activity-icon-for-events-p
**Worker:** 2

### Changes
-- See git log for details
