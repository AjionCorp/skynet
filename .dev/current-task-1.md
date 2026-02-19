# Current Task
## [FEAT] Add self-correction rate calculation to pipeline-status and dashboard — in `packages/dashboard/src/handlers/pipeline-status.ts`, read `.dev/failed-tasks.md` and compute: `fixedCount` (entries with `status=fixed`), `totalAttempted` (entries with status fixed + blocked + superseded), `autoFixRate = fixedCount / totalAttempted * 100`. Add `selfCorrectionRate: number` and `selfCorrectionStats: { fixed: number, blocked: number, superseded: number, pending: number }` to the `PipelineStatus` response. In `packages/dashboard/src/components/PipelineDashboard.tsx`, display the self-correction rate as a percentage badge next to health score (green >=90%, yellow >=70%, red <70%). In `packages/cli/src/commands/status.ts`, output "Self-correction rate: X% (N/M failures auto-fixed)". Add `SelfCorrectionStats` interface to `packages/dashboard/src/types.ts`. This directly measures mission success criterion #2
**Status:** completed
**Started:** 2026-02-19 17:36
**Completed:** 2026-02-19
**Branch:** dev/add-self-correction-rate-calculation-to-
**Worker:** 1

### Changes
-- See git log for details
