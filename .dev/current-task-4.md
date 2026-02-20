# Current Task
## [INFRA] Collapse canonical duplicate `pending` retry rows for the CLI helper DRY root — in `scripts/watchdog.sh` reconciliation, when multiple `pending` rows normalize to `close blocked cli helper dry root for readfile isprocessrunning`, keep one canonical active row, mark the rest `superseded`, and emit per-row `task_superseded` events without modifying active `fixing-*` rows. Mission: Criterion #2 self-correction throughput and Criterion #3 convergent state.
**Status:** completed
**Started:** 2026-02-20 15:58
**Completed:** 2026-02-20
**Branch:** dev/collapse-canonical-duplicate-pending-ret
**Worker:** 4

### Changes
-- See git log for details
