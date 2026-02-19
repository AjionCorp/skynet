# Current Task
## [FEAT] Add `skynet cleanup` CLI command for branch and worktree maintenance — create `packages/cli/src/commands/cleanup.ts`. List all local `dev/*` branches with their status: merged (in main), orphaned (no matching backlog/failed entry), active (has worktree or matching `[>]` claim). Default `--dry-run` mode shows what would be deleted. With `--force`, delete merged/orphaned branches via `git branch -D`, prune worktrees via `git worktree prune`. Show summary: "Deleted N branches, pruned M worktrees, K branches preserved (active)". Register in `packages/cli/src/index.ts`
**Status:** completed
**Started:** 2026-02-19 17:23
**Completed:** 2026-02-19
**Branch:** dev/add-skynet-cleanup-cli-command-for-branc
**Worker:** 2

### Changes
-- See git log for details
