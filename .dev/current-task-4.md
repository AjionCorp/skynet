# Current Task
## [TEST] Add `pause.test.ts`, `resume.test.ts`, `reset-task.test.ts`, and `setup-agents.test.ts` CLI unit tests — create 4 test files in `packages/cli/src/commands/__tests__/`. For `pause.test.ts`: test creates `.dev/pipeline-paused` sentinel file with correct JSON shape `{ pausedAt, pausedBy }`, test no-op when already paused with appropriate message. For `resume.test.ts`: test removes sentinel file, test no-op when not paused. For `reset-task.test.ts`: test fuzzy-matches task title substring in failed-tasks.md, test resets status to pending and attempts to 0, test updates backlog.md entry from `[x]` to `[ ]`, test `--force` flag deletes stale branch. For `setup-agents.test.ts`: test generates launchd plist files on darwin (mock `process.platform`), test generates crontab entries on linux, test `--uninstall` removes agents, test `--dry-run` shows what would be installed. Mock `fs`, `child_process`, and `process.platform`. Criterion #2
**Status:** completed
**Started:** 2026-02-20 00:33
**Completed:** 2026-02-20
**Branch:** dev/add-pausetestts-resumetestts-reset-taskt
**Worker:** 4

### Changes
-- See git log for details
