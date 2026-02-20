# Current Task
## [INFRA] Add completed.md archival to prevent unbounded state file growth — there is NO rotation or archival mechanism for `.dev/completed.md`. With 164+ entries (132KB), it grows with every completed task and is never trimmed. All readers (`project-driver.sh`, `watchdog.sh`, `pipeline-status.ts`, `status.ts`, `metrics.ts`, `changelog.ts`) parse the full file on every invocation. In `scripts/watchdog.sh`, after the existing `_auto_supersede_completed_tasks` call (~line 429), add a new function `_archive_old_completions()`: if completed.md has more than 100 entries (lines after the 2-line header), move entries older than 7 days to `.dev/completed-archive.md` (append, creating if needed), keeping only the last 100 in the active file. Preserve the markdown table header. Log "Archived N completed entries older than 7 days". Update `packages/cli/src/commands/changelog.ts` and `metrics.ts` to also read `completed-archive.md` if it exists (for full historical data). Run `pnpm typecheck`. Criterion #3 (no unbounded resource consumption — completed.md will eventually hit ARG_MAX on the command line)
**Status:** completed
**Started:** 2026-02-20 01:44
**Completed:** 2026-02-20
**Branch:** dev/add-completedmd-archival-to-prevent-unbo
**Worker:** 4

### Changes
-- See git log for details
