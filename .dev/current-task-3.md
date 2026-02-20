# Current Task
## [INFRA] Enforce active-root canonical row precedence (`fixing-*` > `blocked` > `pending`) in watchdog reconciliation — in `scripts/watchdog.sh`, when multiple active rows share a normalized root, deterministically keep the highest-priority status row (then latest row index tie-break), supersede lower-priority variants, and emit `canonicalization_precedence_applied` counters. Mission: Criterion #2 self-correction throughput and Criterion #3 deterministic recovery.
**Status:** completed
**Started:** 2026-02-20 18:17
**Completed:** 2026-02-20
**Branch:** dev/enforce-active-root-canonical-row-preced
**Worker:** 3

### Changes
-- See git log for details
