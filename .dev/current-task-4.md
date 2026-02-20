# Current Task
## [FIX] Add canonical failed-task reconciliation in watchdog — before fixer dispatch in `scripts/watchdog.sh`, run one idempotent pass that dedupes `failed-tasks.md` pending rows by normalized title+branch, supersedes entries matching completed work, and emits `task_superseded` events per transition. Mission: Criterion #2 self-correction and Criterion #3 wasted-cycle elimination.
**Status:** completed
**Started:** 2026-02-20 09:38
**Completed:** 2026-02-20
**Branch:** dev/add-canonical-failed-task-reconciliation
**Worker:** 4

### Changes
-- See git log for details
