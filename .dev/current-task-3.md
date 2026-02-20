# Current Task
## [FIX] Add `SKYNET_ONE_SHOT` and `SKYNET_ONE_SHOT_TASK` to config.ts KNOWN_VARS — `SKYNET_ONE_SHOT` is used in 5+ places in `scripts/watchdog.sh` and 9+ places in `scripts/dev-worker.sh` as a single-task mode flag. `SKYNET_ONE_SHOT_TASK` is used in `dev-worker.sh` and `packages/cli/src/commands/run.ts` line 65. Neither appears in the `KNOWN_VARS` dictionary in `packages/cli/src/commands/config.ts`, making `skynet config list` show blank descriptions. Fix: add `SKYNET_ONE_SHOT: "Set to 1 for single-task mode — worker exits after completing one task"` and `SKYNET_ONE_SHOT_TASK: "Task description for single-task mode (set automatically by skynet run)"` to the KNOWN_VARS object. Run `pnpm typecheck`. Criterion #1 (accurate developer tooling — all config vars described)
**Status:** completed
**Started:** 2026-02-20 03:03
**Completed:** 2026-02-20
**Branch:** dev/add-skynetoneshot-and-skynetoneshottask-
**Worker:** 3

### Changes
-- See git log for details
