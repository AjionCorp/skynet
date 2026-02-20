# Current Task
## [INFRA] Canonicalize duplicate `status=blocked` root variants during watchdog reconciliation — in `scripts/watchdog.sh`, when multiple blocked rows share one normalized root and no `fixing-*` row owns that root, keep one deterministic canonical blocked row (latest row index tie-break, highest attempts preserved), mark lower-priority blocked variants `superseded`, and emit `blocked_duplicates_compacted` counters. Mission: Criterion #2 self-correction throughput and Criterion #3 one-root-one-active-row convergence.
**Status:** completed
**Started:** 2026-02-20 18:54
**Completed:** 2026-02-20
**Branch:** dev/canonicalize-duplicate-statusblocked-roo
**Worker:** 1

### Changes
-- See git log for details
