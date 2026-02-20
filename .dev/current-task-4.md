# Current Task
## [FEAT] Add `skynet init --from-snapshot` to bootstrap from exported state — in `packages/cli/src/commands/init.ts`, add `--from-snapshot <path>` option via `.option('--from-snapshot <path>', 'Initialize from a previously exported pipeline snapshot')`. When provided, after creating the `.dev/` directory structure and copying scripts (the normal init flow), read the JSON snapshot file (same format as `skynet export` output), validate it has expected keys (backlog.md, completed.md, etc.), and overwrite the default state files with the snapshot's content. Log which files were restored: "Restored N files from snapshot". Skip `skynet.config.sh` from the snapshot (machine-specific paths would be wrong — keep the freshly generated one). This enables duplicating a pipeline setup from one project to another, useful for teams adopting Skynet across multiple repositories. Criterion #1 (faster multi-project adoption)
**Status:** completed
**Started:** 2026-02-20 01:13
**Completed:** 2026-02-20
**Branch:** dev/add-skynet-init---from-snapshot-to-boots
**Worker:** 4

### Changes
-- See git log for details
