# Current Task
## [FIX] Add PID lock to health-check.sh to prevent concurrent instances — health-check.sh has no PID lock, so overlapping launchd/cron runs could invoke Claude simultaneously. Add `LOCK_FILE="$SCRIPTS_DIR/health-check.lock"`, acquire via `mkdir "$LOCK_FILE"` at script start with stale detection (same pattern as dev-worker.sh lines ~50-70), release in an EXIT trap. This aligns with the robustness standard set by dev-worker.sh and task-fixer.sh
**Status:** completed
**Started:** 2026-02-19 15:07
**Completed:** 2026-02-19
**Branch:** dev/add-pid-lock-to-health-checksh-to-preven
**Worker:** 2

### Changes
-- See git log for details
