# Current Task
## [INFRA] Run one deterministic failed-task compaction pass after active claims settle — add a one-shot helper in `scripts/watchdog.sh` (or sourced helper) to collapse duplicate `pending|superseded` rows by normalized root+branch in `.dev/failed-tasks.md`, keep one canonical active row, and emit before/after counters via `emit_event`. Mission: Criterion #2 self-correction throughput and Criterion #3 convergent state.
**Status:** completed
**Started:** 2026-02-20 10:41
**Completed:** 2026-02-20
**Branch:** dev/run-one-deterministic-failed-task-compac
**Worker:** 1

### Changes
-- See git log for details
