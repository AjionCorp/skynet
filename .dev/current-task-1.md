# Current Task
## [INFRA] Supersede stale `blocked|pending` rows when a `fixing-*` row already owns the same normalized root — in `scripts/watchdog.sh` reconciliation, when canonical precedence selects a `fixing-*` active row for a root, mark lower-priority active variants (`blocked|pending`) as `superseded` in the same pass and emit deterministic counters (`superseded_by_fixing_root`, `active_roots_after`). Mission: Criterion #2 retry-loop throughput and Criterion #3 one-root-one-active-row convergence.
**Status:** completed
**Started:** 2026-02-20 18:46
**Completed:** 2026-02-20
**Branch:** dev/supersede-stale-blockedpending-rows-when
**Worker:** 1

### Changes
-- See git log for details
