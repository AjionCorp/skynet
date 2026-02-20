# Current Task
## [FIX] Fix `sync-runner.sh` pre-flight check using non-existent API route — `scripts/sync-runner.sh` line 28 checks `curl -sf "$BASE_URL/api/admin/sync-status"` but there is NO `/api/admin/sync-status` route in the admin package (the sync data comes from the pipeline-status handler). This means sync-runner ALWAYS fails the pre-flight check with "Dev server not reachable" even when the server is healthy — the sync logic has never successfully executed. Fix: change line 28 from `"$BASE_URL/api/admin/sync-status"` to `"$BASE_URL/api/admin/pipeline/status"` which exists and returns JSON. Run `pnpm typecheck` to verify. Criterion #3 (reliability — scripts should actually work)
**Status:** completed
**Started:** 2026-02-20 01:25
**Completed:** 2026-02-20
**Branch:** dev/fix-sync-runnersh-pre-flight-check-using
**Worker:** 2

### Changes
-- See git log for details
