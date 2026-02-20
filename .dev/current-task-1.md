# Current Task
## [FIX] Remove ghost `SKYNET_START_DEV_CMD` from config.ts KNOWN_VARS — in `packages/cli/src/commands/config.ts` line 58, `SKYNET_START_DEV_CMD: "Command to start the dev server (optional)"` is listed in `KNOWN_VARS` but this variable does NOT exist in `templates/skynet.config.sh` and is not referenced in any shell script. The actual dev server command variable is `SKYNET_DEV_SERVER_CMD` which is already correctly documented at line 16. `skynet config list` shows a row for a non-existent variable, confusing users who try to set it. Fix: delete line 58 containing `SKYNET_START_DEV_CMD`. Run `pnpm typecheck`. Criterion #1 (accurate developer tooling — no phantom config variables)
**Status:** completed
**Started:** 2026-02-20 02:31
**Completed:** 2026-02-20
**Branch:** dev/remove-ghost-skynetstartdevcmd-from-conf
**Worker:** 1

### Changes
-- See git log for details
