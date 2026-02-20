# Current Task
## [INFRA] Add watchdog `reconcile-only` cycle mode for failed-task convergence and blockers sync — in `scripts/watchdog.sh`, add a one-shot path that runs reconciliation/supersede + blockers refresh + snapshot emission without dispatching workers/fixers, logging deterministic before/after counters. Mission: Criterion #2 self-correction throughput and Criterion #4 trustworthy visibility.
**Status:** completed
**Started:** 2026-02-20 16:51
**Completed:** 2026-02-20
**Branch:** dev/add-watchdog-reconcile-only-cycle-mode-f
**Worker:** 4

### Changes
-- See git log for details
