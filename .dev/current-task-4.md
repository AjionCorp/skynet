# Current Task
## [FEAT] Add `skynet metrics` CLI command for pipeline performance analytics — FRESH implementation (delete stale branch `dev/counts-and-percentages-read-devfailed-ta` first). Create `packages/cli/src/commands/metrics.ts`. Read `.dev/completed.md` (pipe-delimited markdown table with `| Date | Task | Branch | Duration | Notes |`): count total completed, parse Duration column ("Nm" or "Nh Mm" format) to compute average, compute tasks-per-hour, group by tag ([FEAT]/[FIX]/[TEST]/[INFRA]/[DOCS]). Read `.dev/failed-tasks.md`: count by status (fixed/blocked/superseded/pending), compute fix success rate. Output as a formatted console table. Register as `program.command('metrics').description('Show pipeline performance analytics').action(runMetrics)` in `packages/cli/src/index.ts`. Criterion #5
**Status:** completed
**Started:** 2026-02-20 00:20
**Completed:** 2026-02-20
**Branch:** dev/add-skynet-metrics-cli-command-for-pipel
**Worker:** 4

### Changes
-- See git log for details
