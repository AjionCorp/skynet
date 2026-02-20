# Current Task
## [FIX] Use configurable `SKYNET_AUTH_NOTIFY_INTERVAL` in auth-check.sh instead of hardcoded value — in `scripts/auth-check.sh` line 16, `AUTH_NOTIFY_INTERVAL=3600` is hardcoded, ignoring the `SKYNET_AUTH_NOTIFY_INTERVAL=3600` defined in `templates/skynet.config.sh` line 59. The config variable is dead — changing it has no effect. Fix: change line 16 from `AUTH_NOTIFY_INTERVAL=3600` to `AUTH_NOTIFY_INTERVAL="${SKYNET_AUTH_NOTIFY_INTERVAL:-3600}"`. Also check if `CODEX_NOTIFY_INTERVAL` (around line 102) has the same issue and apply the same pattern. Run `pnpm typecheck`. Criterion #3 (config variables must actually be honored — no dead config)
**Status:** completed
**Started:** 2026-02-20 02:05
**Completed:** 2026-02-20
**Branch:** dev/use-configurable-skynetauthnotifyinterva
**Worker:** 2

### Changes
-- See git log for details
