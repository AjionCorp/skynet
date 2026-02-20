# Current Task
## [INFRA] Enforce canonical failed-task convergence before fixer dispatch — in `scripts/watchdog.sh`, add a pre-dispatch invariant pass that keeps exactly one active row per normalized root (`pending|fixing-*|blocked`) in `.dev/failed-tasks.md`, supersedes duplicates, and emits per-root reconciliation counts. Mission: Criterion #2 self-correction throughput and Criterion #3 convergent state.
**Status:** completed
**Started:** 2026-02-20 10:04
**Completed:** 2026-02-20
**Branch:** dev/enforce-canonical-failed-task-convergenc
**Worker:** 2

### Changes
-- See git log for details
