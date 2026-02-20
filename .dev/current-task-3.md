# Current Task
## [INFRA] Add failed-task history rotation guardrail to keep fixer context bounded — in `scripts/watchdog.sh`, move older `fixed|superseded` rows beyond a cap from `.dev/failed-tasks.md` to `.dev/failed-tasks-archive.md` while preserving active `pending|fixing-*|blocked` rows order. Mission: Criterion #2 retry-loop throughput and Criterion #3 deterministic state management.
**Status:** completed
**Started:** 2026-02-20 16:18
**Completed:** 2026-02-20
**Branch:** dev/add-failed-task-history-rotation-guardra
**Worker:** 3

### Changes
-- See git log for details
