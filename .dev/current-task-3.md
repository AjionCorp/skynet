# Current Task
## [INFRA] Enforce unchecked backlog hard-cap and canonical ordering in project-driver writes — in `scripts/project-driver.sh`, after task generation and before write, deterministically keep all claimed `[>]` rows first, then pending `[ ]`, trim lowest-priority pending rows beyond 15 unchecked total, and preserve checked history rows without mutation. Mission: Criterion #3 deterministic planning state and Criterion #2 no-task-loss reliability.
**Status:** completed
**Started:** 2026-02-20 18:46
**Completed:** 2026-02-20
**Branch:** dev/enforce-unchecked-backlog-hard-cap-and-c
**Worker:** 3

### Changes
-- See git log for details
