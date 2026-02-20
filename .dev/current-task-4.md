# Current Task
## [FEAT] Add `skynet doctor --fix` auto-remediation mode — in `packages/cli/src/commands/doctor.ts`, add `--fix` boolean option. When a check fails and has a known remediation: (a) stale heartbeats → delete the stale `.dev/worker-N.heartbeat` file, (b) orphaned worktrees → run `git worktree prune` via `execSync`, (c) orphaned claimed tasks (claimed `[>]` in backlog but no matching worker) → reset from `[>]` to `[ ]` in backlog.md, (d) missing required config vars → append defaults from template. Print "Auto-fixed N issues" summary. Without `--fix`, behavior is unchanged (report only). Register the flag via `.option('--fix', 'Auto-fix issues where possible')`. Criterion #1 (self-healing accessible to users) and #3 (faster recovery)
**Status:** completed
**Started:** 2026-02-20 00:36
**Completed:** 2026-02-20
**Branch:** dev/add-skynet-doctor---fix-auto-remediation
**Worker:** 4

### Changes
-- See git log for details
