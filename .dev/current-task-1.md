# Current Task
## [FEAT] Add backlog health validation to watchdog — add a `validate_backlog()` function in scripts/_config.sh that checks: (1) no duplicate task titles in pending items, (2) no orphaned `[>]` (claimed) entries without a matching active worker in current-task-N.md files, (3) `blockedBy` references point to tasks that actually exist in backlog or completed. Call from watchdog.sh on each run. Log warnings for any issues found, auto-fix orphaned claims by resetting to `[ ]`
**Status:** completed
**Started:** 2026-02-19 15:21
**Completed:** 2026-02-19
**Branch:** dev/add-backlog-health-validation-to-watchdo
**Worker:** 1

### Changes
-- See git log for details
