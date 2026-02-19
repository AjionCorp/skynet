# Current Task
## [FEAT] Add `skynet reset-task` CLI command — create packages/cli/src/commands/reset-task.ts. Usage: `skynet reset-task "task title substring"`. Searches failed-tasks.md for a matching entry, resets its status to pending and attempts to 0, finds the corresponding `[x]` entry in backlog.md and changes it back to `[ ]`. If the failed branch still exists, offers to delete it (with --force flag to skip confirmation). Register in packages/cli/src/index.ts
**Status:** completed
**Started:** 2026-02-19 17:01
**Completed:** 2026-02-19
**Branch:** dev/add-skynet-reset-task-cli-command--creat
**Worker:** 2

### Changes
-- See git log for details
