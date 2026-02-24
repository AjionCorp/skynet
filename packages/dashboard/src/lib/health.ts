/**
 * Pipeline health score calculation.
 *
 * Extracted from pipeline-status.ts for reuse and testability.
 *
 * Keep in sync with canonical formula in:
 *   - packages/dashboard/src/lib/db.ts (SkynetDB.calculateHealthScore)
 *   - packages/cli/src/commands/status.ts (healthScore calculation)
 *   - scripts/watchdog.sh (_health_score_alert)
 *
 * ## Scoring Model
 *
 * The score starts at 100 (fully healthy) and applies subtractive penalties
 * for each active issue. The penalty weights reflect operational severity:
 *
 *   - **Blockers (-10 each):** Highest weight because they halt forward progress
 *     entirely — no tasks can proceed past a blocker.
 *   - **Failed tasks (-5 each):** Moderate weight — failures consume fixer
 *     capacity and may indicate systemic issues, but the pipeline can still
 *     make progress on other tasks.
 *   - **Stale heartbeats (-2 each):** Lower weight — a stale heartbeat means a
 *     worker *may* be stuck, but the watchdog will kill it soon. It's a
 *     transient signal, not a persistent problem.
 *   - **Stale tasks >24h (-1 each):** Lowest weight — a long-running task is
 *     not necessarily broken (some tasks are legitimately large), but prolonged
 *     stalling across many workers suggests throughput degradation.
 *
 * Example scores:
 *   - 100: No issues — pipeline fully healthy
 *   -  80: 2 failed tasks, 1 blocker (100 - 10 - 10 = 80)
 *   -  50: Default alert threshold (SKYNET_HEALTH_ALERT_THRESHOLD)
 *   -   0: Floor — many concurrent issues
 */

export interface HealthScoreParams {
  failedPendingCount: number;
  blockerCount: number;
  staleHeartbeatCount: number;
  staleTasks24hCount: number;
}

// Penalty weights per issue type — see scoring model documentation above.
// Blockers are the most severe (halt all progress), followed by failures
// (consume fixer capacity), stale heartbeats (transient), and stale tasks
// (potentially legitimate long-running work).
const PENALTY_FAILED_TASK = 5;   // -5 per pending failed task
const PENALTY_BLOCKER = 10;      // -10 per active blocker
const PENALTY_STALE_HEARTBEAT = 2; // -2 per worker with stale heartbeat
const PENALTY_STALE_TASK = 1;    // -1 per task in_progress >24h

/**
 * Calculate a pipeline health score (0-100).
 * Starts at 100 and deducts penalties for active issues.
 * See scoring model documentation at the top of this file.
 */
export function calculateHealthScore(opts: HealthScoreParams): number {
  // TEST-P3-3: Formula documentation
  // score = 100 - (failed * 5) - (blockers * 10) - (staleHB * 2) - (staleTasks * 1)
  // Result is clamped to [0, 100]. Weight rationale:
  //   Blockers (10): halt all progress — highest impact
  //   Failed (5):    consume fixer capacity, indicate systemic issues
  //   Stale HB (2):  transient — watchdog will recover soon
  //   Stale 24h (1): may be legitimate long tasks
  let score = 100;
  score -= opts.failedPendingCount * PENALTY_FAILED_TASK;
  score -= opts.blockerCount * PENALTY_BLOCKER;
  score -= opts.staleHeartbeatCount * PENALTY_STALE_HEARTBEAT;
  score -= opts.staleTasks24hCount * PENALTY_STALE_TASK;
  return Math.max(0, Math.min(100, score));
}
