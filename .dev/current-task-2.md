# Current Task
## [FEAT] Add `skynet upgrade` CLI command for self-update — create `packages/cli/src/commands/upgrade.ts`. Check current installed version vs npm registry latest via `npm view @ajioncorp/skynet-cli version`. If outdated, run `npm install -g @ajioncorp/skynet-cli@latest` via `child_process.execSync`. If up-to-date, print "Already on latest version (X.Y.Z)". Add `--check` flag for dry-run that only reports whether an update is available without installing. Register in `packages/cli/src/index.ts`. Criterion #1 (developer experience — smooth upgrade path)
**Status:** completed
**Started:** 2026-02-19 22:04
**Completed:** 2026-02-19
**Branch:** dev/add-skynet-upgrade-cli-command-for-self-
**Worker:** 2

### Changes
-- See git log for details
