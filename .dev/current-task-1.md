# Current Task
## [FIX] Fix CLI status command hardcoded worker heartbeat and worker list — in `packages/cli/src/commands/status.ts`, line 212 has `for (let wid = 1; wid <= 2; wid++)` which only checks workers 1-2 for heartbeat staleness. With `SKYNET_MAX_WORKERS=4`, workers 3-4 are invisible to the health score calculation. Fix: read `SKYNET_MAX_WORKERS` from the config object (already available as `vars`) and use `for (let wid = 1; wid <= maxWorkers; wid++)`. Also update the `workers` array (line 234) which hardcodes `"dev-worker-1", "dev-worker-2"` — dynamically generate entries for all `maxWorkers` workers. This ensures `skynet status` accurately reflects all running workers. Criterion #3 (no hidden stale workers) and #1 (accurate status output)
**Status:** completed
**Started:** 2026-02-19 21:01
**Completed:** 2026-02-19
**Branch:** dev/fix-cli-status-command-hardcoded-worker-
**Worker:** 1

### Changes
-- See git log for details
