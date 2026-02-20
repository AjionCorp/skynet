# Current Task
## [FIX] Move health alert sentinel from `.dev/` to `/tmp/` — in `scripts/watchdog.sh` line 507, the health alert sentinel is written to `$DEV_DIR/health-alert-sent` (the project's `.dev/` directory). This creates an untracked git file in the working directory and pollutes the project state. All other runtime sentinel and lock files correctly live in `/tmp/skynet-*`. Fix: change line 507 from `local sentinel="$DEV_DIR/health-alert-sent"` to `local sentinel="/tmp/skynet-${SKYNET_PROJECT_NAME:-skynet}-health-alert-sent"`. This matches the existing convention for lock files (`$SKYNET_LOCK_PREFIX-*`). Run `pnpm typecheck`. Criterion #3 (clean project state — no transient files in `.dev/`)
**Status:** completed
**Started:** 2026-02-20 01:50
**Completed:** 2026-02-20
**Branch:** dev/move-health-alert-sentinel-from-dev-to-t
**Worker:** 3

### Changes
-- See git log for details
