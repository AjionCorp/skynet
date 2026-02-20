# Current Task
## [INFRA] Centralize failed-root normalization helpers in shared shell config — move duplicated root/title normalization logic from `scripts/project-driver.sh` and `scripts/watchdog.sh` into `scripts/_config.sh` helpers, then migrate callers to one canonical implementation to prevent drift in dedupe/supersede semantics. Mission: Criterion #3 convergent state and Criterion #2 retry-loop reduction.
**Status:** completed
**Started:** 2026-02-20 18:33
**Completed:** 2026-02-20
**Branch:** dev/centralize-failed-root-normalization-hel
**Worker:** 3

### Changes
-- See git log for details
