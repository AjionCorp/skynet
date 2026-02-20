# Current Task
## [FIX] Consolidate duplicate port config variables `SKYNET_DEV_SERVER_PORT` and `SKYNET_DEV_PORT` — in `templates/skynet.config.sh` lines 17-18, two separate port variables exist: `SKYNET_DEV_SERVER_PORT=3000` and `SKYNET_DEV_PORT=3000`. The `init.ts` command (line 146) substitutes only `SKYNET_DEV_SERVER_PORT` when user passes `--port`, but `scripts/_config.sh` and `dev-worker.sh` only read `SKYNET_DEV_PORT` for runtime port calculation. This means `skynet init --port 4000` has no effect on workers — they still use port 3000. Fix: (1) remove `SKYNET_DEV_SERVER_PORT` from the template, keep only `SKYNET_DEV_PORT`. (2) In `packages/cli/src/commands/init.ts` line 146, change the `.replace()` target from `SKYNET_DEV_SERVER_PORT` to `SKYNET_DEV_PORT`. (3) Update `start-dev.sh` if it references `SKYNET_DEV_SERVER_PORT`. (4) Remove `SKYNET_DEV_SERVER_PORT` from `KNOWN_VARS` in `config.ts` if present. Run `pnpm typecheck`. Criterion #1 (correct init — user-specified port must actually take effect)
**Status:** completed
**Started:** 2026-02-20 02:05
**Completed:** 2026-02-20
**Branch:** dev/consolidate-duplicate-port-config-variab
**Worker:** 1

### Changes
-- See git log for details
