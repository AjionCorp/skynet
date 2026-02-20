# Current Task
## [INFRA] Prevent project-driver from generating retry variants for active failed roots — in `scripts/project-driver.sh`, normalize unchecked candidate titles against active `pending|blocked|fixing-*` roots in `.dev/failed-tasks.md`, skip generation when a canonical root is already active, and log deterministic `driver_duplicate_root_skipped` counters. Mission: Criterion #2 retry-loop reduction and Criterion #3 durable root-cause planning.
**Status:** completed
**Started:** 2026-02-20 18:11
**Completed:** 2026-02-20
**Branch:** dev/prevent-project-driver-from-generating-r
**Worker:** 2

### Changes
-- See git log for details
