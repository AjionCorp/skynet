# Current Task
## [FIX] Harden project-driver.sh against missing .dev/ state files — in `scripts/project-driver.sh`, before each `cat` call that reads `.dev/*.md` files (~lines 70-90), add an existence check: `if [ -f "$file" ]; then cat "$file"; else echo "(file not found)"; fi`. Guard: `completed.md`, `failed-tasks.md`, `blockers.md`, `sync-health.md`, and each `current-task-N.md`. Also guard the `find` commands for API routes and pages with `-d` directory checks. On a fresh `skynet init` project some files won't exist yet — the driver should handle this gracefully rather than crashing — criterion #3 (no crashes)
**Status:** completed
**Started:** 2026-02-19 18:05
**Completed:** 2026-02-19
**Branch:** dev/harden-project-driversh-against-missing-
**Worker:** 4

### Changes
-- See git log for details
