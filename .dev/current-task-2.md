# Current Task
## [FIX] Use mkdir-based atomic lock for watchdog PID singleton enforcement — in `scripts/watchdog.sh` lines 22-31, the PID lock uses a file-based check-then-write pattern: `if [ -f "$WATCHDOG_LOCK" ]; then ... rm -f; fi; echo $$ > "$WATCHDOG_LOCK"`. This has a TOCTOU race — between `rm -f` and `echo $$`, a second watchdog can pass the check and both believe they're the singleton. The same pattern exists in `scripts/dev-worker.sh` lines 254-259. Fix: replace the PID file approach with `mkdir`-based atomic locking (same pattern as the backlog mutex at `scripts/_config.sh`). Use `mkdir "$WATCHDOG_LOCK_DIR" 2>/dev/null` as the atomic test-and-set, then write `$$` inside it as `pid`. On cleanup, `rm -rf "$WATCHDOG_LOCK_DIR"`. Apply the same fix to `dev-worker.sh`. Run `pnpm typecheck`. Criterion #3 (no race conditions in singleton enforcement)
**Status:** completed
**Started:** 2026-02-20 01:55
**Completed:** 2026-02-20
**Branch:** dev/use-mkdir-based-atomic-lock-for-watchdog
**Worker:** 2

### Changes
-- See git log for details
