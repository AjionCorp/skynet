# Current Task
## [INFRA] Add retry-pressure mode in `scripts/project-driver.sh` when pending retries exceed threshold — if `failed-tasks.md` pending count is `> 20`, generate at most 3 new tasks per cycle, restrict output to reliability/reconciliation tags (`[FIX]`, `[INFRA]`, `[TEST]`, `[NMI]`), and emit `driver_retry_pressure_mode` metrics. Mission: Criterion #2 self-correction throughput and Criterion #3 convergent planning.
**Status:** completed
**Started:** 2026-02-20 10:53
**Completed:** 2026-02-20
**Branch:** dev/add-retry-pressure-mode-in-scriptsprojec
**Worker:** 1

### Changes
-- See git log for details
