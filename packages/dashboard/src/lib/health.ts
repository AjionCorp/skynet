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

// Penalty weights per issue type
const PENALTY_FAILED_TASK = 5;
const PENALTY_BLOCKER = 10;
const PENALTY_STALE_HEARTBEAT = 2;
const PENALTY_STALE_TASK = 1;

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
  score -= opts.failedPendingCount * PENALTY_FAILED_TASK;
  score -= opts.blockerCount * PENALTY_BLOCKER;
  score -= opts.staleHeartbeatCount * PENALTY_STALE_HEARTBEAT;
  score -= opts.staleTasks24hCount * PENALTY_STALE_TASK;
  return Math.max(0, Math.min(100, score));
}
