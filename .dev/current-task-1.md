# Current Task
## [FIX] Fix `check-server-errors.sh` hardcoded log path breaking multi-worker server error scanning — `scripts/check-server-errors.sh` line 9 hardcodes `SERVER_LOG="$SCRIPTS_DIR/next-dev.log"` but `dev-worker.sh` creates per-worker logs at `$SCRIPTS_DIR/next-dev-w${WORKER_ID}.log`. This means the server error check (called at `dev-worker.sh` line 534) always exits early with "No server log found" — server errors are silently undetected. Fix: change line 9 to `SERVER_LOG="${1:-$SCRIPTS_DIR/next-dev.log}"` to accept an optional log path argument. In `dev-worker.sh` line 534, pass the worker-specific log: `bash "$SCRIPTS_DIR/check-server-errors.sh" "$SCRIPTS_DIR/next-dev-w${WORKER_ID}.log"`. This makes server error detection actually work for multi-worker setups. Run `pnpm typecheck` to verify no breakage. Criterion #3 (no silent failures)
**Status:** completed
**Started:** 2026-02-20 01:25
**Completed:** 2026-02-20
**Branch:** dev/fix-check-server-errorssh-hardcoded-log-
**Worker:** 1

### Changes
-- See git log for details
