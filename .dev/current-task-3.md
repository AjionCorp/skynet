# Current Task
## [FIX] Fix watchdog zombie detection to check heartbeat before killing alive workers — in `scripts/watchdog.sh` lines 149-155, the `crash_recovery()` function determines zombies using lock directory mtime: `lock_mtime=$(file_mtime "$lockfile"); lock_age_secs=$((now - lock_mtime))`. If `lock_age_secs > stale_secs`, the worker is killed — even if its heartbeat is fresh. A legitimately running worker on a slow 50-minute task gets killed because the lock dir mtime (set at creation, never updated) exceeds `SKYNET_STALE_MINUTES`. Fix: before killing at line 155, check the corresponding heartbeat file: `local hb_file="$DEV_DIR/worker-${wid}.heartbeat"` and if it exists and is recent (within stale_secs), log "Worker $wid lock is old but heartbeat is fresh — skipping" and continue. Only kill when BOTH the lock is stale AND the heartbeat is stale or missing. Run `pnpm typecheck`. Criterion #3 (no false-positive zombie kills — prevents legitimate work from being lost)
**Status:** completed
**Started:** 2026-02-20 02:20
**Completed:** 2026-02-20
**Branch:** dev/fix-watchdog-zombie-detection-to-check-h
**Worker:** 3

### Changes
-- See git log for details
