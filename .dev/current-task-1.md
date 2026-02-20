# Current Task
## [FEAT] Add `skynet watch` command for real-time terminal monitoring — create `packages/cli/src/commands/watch.ts`. Uses a 3-second `setInterval` loop that clears screen and renders a compact dashboard: (1) Header with project name + health score (colored via ANSI), (2) Workers table with ID, status (idle/active), current task (truncated 60 chars), heartbeat age, (3) Task summary line (pending/claimed/completed/failed), (4) Self-correction rate, (5) Last 5 events from `.dev/events.log` with timestamps. Use ANSI codes (`\x1b[32m` green, `\x1b[33m` yellow, `\x1b[31m` red, `\x1b[0m` reset). Read state from `.dev/` files (same pattern as `status.ts`). Exit cleanly on SIGINT. Register in `packages/cli/src/index.ts`. Criterion #1 (monitor pipeline without browser)
**Status:** completed
**Started:** 2026-02-19 23:20
**Completed:** 2026-02-19
**Branch:** dev/add-skynet-watch-command-for-real-time-t
**Worker:** 1

### Changes
-- See git log for details
