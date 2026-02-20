# Current Task
## [INFRA] Add watchdog preflight sanitizer for malformed failed-task rows before dispatch — add one idempotent pass in `scripts/watchdog.sh` that validates `.dev/failed-tasks.md` row column counts, repairs only known legacy corruption patterns from unescaped table pipes, and emits before/after counters (`rows_scanned`, `rows_repaired`, `rows_skipped`). Mission: Criterion #2 self-correction throughput and Criterion #3 convergent recovery state.
**Status:** completed
**Started:** 2026-02-20 18:04
**Completed:** 2026-02-20
**Branch:** dev/add-watchdog-preflight-sanitizer-for-mal
**Worker:** 2

### Changes
-- See git log for details
