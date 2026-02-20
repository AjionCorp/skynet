# Current Task
## [INFRA] Add stale-claimed backlog recovery sweep tied to live lock/worktree state — in `scripts/watchdog.sh`, detect `[>]` rows with no corresponding active lock/heartbeat/worktree and atomically demote them back to `[ ]` to prevent permanent claimed starvation. Mission: Criterion #3 no-task-loss guarantees and Criterion #2 throughput.
**Status:** completed
**Started:** 2026-02-20 16:49
**Completed:** 2026-02-20
**Branch:** dev/add-stale-claimed-backlog-recovery-sweep
**Worker:** 1

### Changes
-- See git log for details
