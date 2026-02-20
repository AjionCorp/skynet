# Current Task
## [FIX] Harden failed-task table parsing for legacy unescaped pipe rows — in `scripts/_config.sh` parsing helpers and watchdog reconciliation reads, treat malformed pipe-expanded rows as recoverable (skip or normalize with explicit guard) instead of misclassifying status/attempt columns; emit deterministic skip logs with row index and preserve valid rows byte-for-byte. Mission: Criterion #3 deterministic state and Criterion #2 retry-loop stability.
**Status:** completed
**Started:** 2026-02-20 18:03
**Completed:** 2026-02-20
**Branch:** dev/harden-failed-task-table-parsing-for-leg
**Worker:** 1

### Changes
-- See git log for details
