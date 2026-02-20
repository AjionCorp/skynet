# Current Task
## [FEAT] Add `skynet import` CLI command for restoring pipeline state from snapshot — create `packages/cli/src/commands/import.ts`. Reads a JSON snapshot file (produced by `skynet export`), validates it has expected keys (backlog.md, completed.md, failed-tasks.md, blockers.md, mission.md, skynet.config.sh), then writes each key's string value back to the corresponding `.dev/` file. Add `--dry-run` flag that shows which files would be overwritten and their size changes without writing. Add `--merge` flag that appends rather than overwrites for .md files. Prompt for confirmation before overwriting (unless `--force` flag). Register in `packages/cli/src/index.ts`. Criterion #1 (complete state management lifecycle — export + import)
**Status:** completed
**Started:** 2026-02-20 00:36
**Completed:** 2026-02-20
**Branch:** dev/add-skynet-import-cli-command-for-restor
**Worker:** 3

### Changes
-- See git log for details
