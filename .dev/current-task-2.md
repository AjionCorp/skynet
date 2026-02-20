# Current Task
## [FIX] Make failed-task markdown row writes pipe-safe across writers — in `scripts/task-fixer.sh` and any shared failed-task write helpers, escape or encode literal `|` in task/error/branch fields so `.dev/failed-tasks.md` remains parse-stable and row corruption cannot create phantom duplicates. Mission: Criterion #3 deterministic state and Criterion #2 retry-loop reliability.
**Status:** completed
**Started:** 2026-02-20 16:40
**Completed:** 2026-02-20
**Branch:** dev/make-failed-task-markdown-row-writes-pip
**Worker:** 2

### Changes
-- See git log for details
