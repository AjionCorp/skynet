# Current Task
## [FEAT] Add pipeline health score to dashboard and `skynet status` — create a `calculate_health_score()` function. Formula: start at 100, subtract 5 per pending failed task, subtract 10 per active blocker, subtract 2 per stale heartbeat, subtract 1 per task pending >24h. Clamp to 0-100. Add to packages/dashboard/src/handlers/pipeline-status.ts response as `healthScore: number`. Display as a colored badge in PipelineDashboard component (green >80, yellow >50, red <=50). Also output in packages/cli/src/commands/status.ts
**Status:** completed
**Started:** 2026-02-19 16:58
**Completed:** 2026-02-19
**Branch:** dev/add-pipeline-health-score-to-dashboard-a
**Worker:** 2

### Changes
-- See git log for details
