# Current Task
## [FIX] Migrate sync-runner.sh, feature-validator.sh, and ui-tester.sh to mkdir-based atomic PID locks — three scripts still use legacy file-based PID locks with a TOCTOU race window. (1) `scripts/sync-runner.sh` lines 19-25: `if [ -f "$LOCKFILE" ] && kill -0 ... echo $$ > "$LOCKFILE"`. (2) `scripts/feature-validator.sh` lines 19-25: identical pattern. (3) `scripts/ui-tester.sh` lines 18-24: identical pattern. All other main scripts (`watchdog.sh`, `dev-worker.sh`, `task-fixer.sh`, `project-driver.sh`) were already migrated to mkdir-based atomic locks. Fix: in each of the 3 files, replace the `if [ -f ] ... echo $$ >` block with `mkdir "$LOCKFILE" 2>/dev/null || { ... check stale ... exit 0; }; echo $$ > "$LOCKFILE/pid"`. Update each cleanup trap from `rm -f "$LOCKFILE"` to `rm -rf "$LOCKFILE"`. Follow the exact pattern in `scripts/health-check.sh` lines 17-32 (which already uses mkdir). Run `bash -n scripts/sync-runner.sh scripts/feature-validator.sh scripts/ui-tester.sh` and `pnpm typecheck`. Criterion #3 (no race conditions — consistent locking across all scripts)
**Status:** completed
**Started:** 2026-02-20 02:48
**Completed:** 2026-02-20
**Branch:** dev/-echo---block-with-mkdir-lockfile-2devnu
**Worker:** 3

### Changes
-- See git log for details
