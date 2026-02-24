/**
 * Pipeline health score calculation.
 *
 * Extracted from pipeline-status.ts for reuse and testability.
 *
 * Keep in sync with canonical formula in:
 *   - packages/dashboard/src/lib/db.ts (SkynetDB.calculateHealthScore)
 *   - packages/cli/src/commands/status.ts (healthScore calculation)
 *   - scripts/watchdog.sh (_health_score_alert)
 */

export interface HealthScoreParams {
  failedPendingCount: number;
  blockerCount: number;
  staleHeartbeatCount: number;
  staleTasks24hCount: number;
}

/**
 * Calculate a pipeline health score (0-100).
 * Starts at 100 and deducts for issues:
 *   -5 per pending failed task
 *  -10 per active blocker
 *   -2 per stale heartbeat
 *   -1 per task that has been in progress >24 hours
 */
export function calculateHealthScore(opts: HealthScoreParams): number {
  let score = 100;
  score -= opts.failedPendingCount * 5;
  score -= opts.blockerCount * 10;
  score -= opts.staleHeartbeatCount * 2;
  score -= opts.staleTasks24hCount * 1;
  return Math.max(0, Math.min(100, score));
}
