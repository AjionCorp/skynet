# Current Task
## [FIX] Unify stale-threshold and health-score parity across CLI/dashboard/watchdog — align `packages/cli/src/commands/status.ts`, `packages/cli/src/commands/watch.ts`, `packages/dashboard/src/handlers/pipeline-status.ts`, and `scripts/watchdog.sh` to shared `SKYNET_STALE_MINUTES` input and identical deductions (`failed`, `blockers`, `staleHeartbeats`, `staleTasks24h`) with score-breakdown logging. Mission: Criterion #4 telemetry consistency and Criterion #3 deterministic behavior.
**Status:** completed
**Started:** 2026-02-20 09:48
**Completed:** 2026-02-20
**Branch:** dev/unify-stale-threshold-and-health-score-p
**Worker:** 3

### Changes
-- See git log for details
