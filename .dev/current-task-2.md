# Current Task
## [INFRA] Compact duplicate non-active failed history rows before archive rotation — in `scripts/watchdog.sh`, collapse repeated `fixed|superseded` rows with the same normalized root+branch into one canonical history row before moving rows to `.dev/failed-tasks-archive.md`, preserving the newest attempts/error context and emitting deterministic `history_rows_compacted` metrics. Mission: Criterion #2 retry-loop throughput and Criterion #3 state convergence.
**Status:** completed
**Started:** 2026-02-20 18:19
**Completed:** 2026-02-20
**Branch:** dev/compact-duplicate-non-active-failed-hist
**Worker:** 2

### Changes
-- See git log for details
