# Current Task
## [FEAT] Add `skynet config` CLI command for viewing and editing configuration — create `packages/cli/src/commands/config.ts`. Three subcommands: (1) `skynet config list` (default) — read `.dev/skynet.config.sh`, parse lines matching `export VAR="value"` or `VAR="value"`, display as a formatted table with Variable, Value, Description columns. (2) `skynet config get KEY` — show single variable value. (3) `skynet config set KEY VALUE` — find the line with `KEY=` and replace the value, using atomic write (write .tmp, rename). Validate known keys: SKYNET_MAX_WORKERS must be positive integer, SKYNET_STALE_MINUTES must be >= 5, SKYNET_MAIN_BRANCH must be a valid git branch. Register in `packages/cli/src/index.ts`
**Status:** completed
**Started:** 2026-02-19 17:44
**Completed:** 2026-02-19
**Branch:** dev/add-skynet-config-cli-command-for-viewin
**Worker:** 3

### Changes
-- See git log for details
