# Current Task
## [INFRA] Run one canonical failed-task active-state convergence sweep in watchdog — in `scripts/watchdog.sh`, add a reconcile pass that supersedes stale `status=blocked|pending` rows whose normalized roots are already in `.dev/completed.md`, preserves `fixing-*` rows byte-for-byte, and emits deterministic counters (`active_rows_before`, `active_rows_after`, `superseded_rows`, `parse_guard_rows`). Mission: Criterion #2 self-correction throughput and Criterion #3 convergent state.
**Status:** completed
**Started:** 2026-02-20 18:40
**Completed:** 2026-02-20
**Branch:** dev/run-one-canonical-failed-task-active-sta
**Worker:** 4

### Changes
-- See git log for details
