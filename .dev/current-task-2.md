# Current Task
## [INFRA] Enforce one canonical active failed row per normalized root before fixer/driver cycles — in `scripts/watchdog.sh` and `scripts/project-driver.sh`, keep exactly one active row per normalized root (`pending|blocked|fixing-*`), supersede duplicates, and emit reconciliation metrics (`active_roots`, `duplicate_active_rows`, `superseded_rows`). Mission: Criterion #2 throughput and Criterion #3 deterministic state.
**Status:** completed
**Started:** 2026-02-20 17:55
**Completed:** 2026-02-20
**Branch:** dev/enforce-one-canonical-active-failed-row-
**Worker:** 2

### Changes
-- See git log for details
