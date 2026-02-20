# Current Task
## [FIX] Fix health-check.sh lock path using `$SCRIPTS_DIR` instead of `$SKYNET_LOCK_PREFIX` — in `scripts/health-check.sh` line 15, `LOCK_FILE="$SCRIPTS_DIR/health-check.lock"` places the lock inside `.dev/scripts/` instead of `/tmp/skynet-{project}-*`. Every other script uses `${SKYNET_LOCK_PREFIX}-{name}.lock` (resolving to `/tmp/`). This causes three problems: (a) `skynet doctor` scans `${lockPrefix}-health-check.lock` at the temp path, never finding it — health-check always shows as "not running", (b) `skynet stop` cannot stop health-check for the same reason, (c) the lock directory pollutes the project's `.dev/scripts/` directory. Fix: change line 15 from `LOCK_FILE="$SCRIPTS_DIR/health-check.lock"` to `LOCK_FILE="${SKYNET_LOCK_PREFIX}-health-check.lock"`. Run `bash -n scripts/health-check.sh` and `pnpm typecheck`. Criterion #3 (consistent lock paths — all CLI tools can discover and manage all running processes)
**Status:** completed
**Started:** 2026-02-20 02:47
**Completed:** 2026-02-20
**Branch:** dev/fix-health-checksh-lock-path-using-scrip
**Worker:** 1

### Changes
-- See git log for details
