# Current Task
## [FIX] Throttle net-new task generation when retry queue is overloaded — when `.dev/failed-tasks.md` has `pending > 20`, make `scripts/project-driver.sh` skip net-new feature generation and emit only reliability/reconciliation tasks until pending retries drop below threshold. Mission: Criterion #2 self-correction stability and Criterion #3 reliability.
**Status:** completed
**Started:** 2026-02-20 10:05
**Completed:** 2026-02-20
**Branch:** dev/throttle-net-new-task-generation-when-re
**Worker:** 4

### Changes
-- See git log for details
