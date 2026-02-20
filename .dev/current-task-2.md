# Current Task
## [FIX] Migrate task-fixer.sh and project-driver.sh to mkdir-based atomic PID locks — `scripts/task-fixer.sh` lines 98-102 and `scripts/project-driver.sh` lines 26-31 still use legacy file-based PID locks (`echo $$ > "$LOCKFILE"`) with a TOCTOU race window. `watchdog.sh` and `dev-worker.sh` were already migrated to mkdir-based atomic locks. Fix: (1) In `task-fixer.sh`, replace the `if [ -f "$LOCKFILE" ]...echo $$ > "$LOCKFILE"` block with `mkdir "$LOCKFILE" 2>/dev/null || { ... }; echo $$ > "$LOCKFILE/pid"`. Update `cleanup_on_exit` at line 155 from `rm -f "$LOCKFILE"` to `rm -rf "$LOCKFILE"`. (2) Apply the same pattern to `project-driver.sh` lines 26-31 and its cleanup. (3) In `dev-worker.sh` line 395, update the project-driver lock check from `cat "${SKYNET_LOCK_PREFIX}-project-driver.lock"` to `cat "${SKYNET_LOCK_PREFIX}-project-driver.lock/pid"` since the lock is now a directory. Run `pnpm typecheck` and `bash -n scripts/task-fixer.sh scripts/project-driver.sh`. Criterion #3 (no race conditions — prevents duplicate fixer/driver instances)
**Status:** completed
**Started:** 2026-02-20 02:21
**Completed:** 2026-02-20
**Branch:** dev/migrate-task-fixersh-and-project-drivers
**Worker:** 2

### Changes
-- See git log for details
