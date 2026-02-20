# Current Task
## [INFRA] Reconcile stale `fixing-*` failed-task rows by fixer lock liveness — before fixer dispatch, detect `status=fixing-*` rows whose fixer lock/PID is absent and atomically return them to canonical `pending` (or supersede if resolved) to prevent retry starvation. Mission: Criterion #2 self-correction continuity and Criterion #3 deterministic recovery.
**Status:** completed
**Started:** 2026-02-20 10:11
**Completed:** 2026-02-20
**Branch:** dev/reconcile-stale-fixing--failed-task-rows
**Worker:** 1

### Changes
-- See git log for details
