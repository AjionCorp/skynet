import type { SkynetConfig } from "../types";
import { getSkynetDB } from "../lib/db";

/**
 * Create a GET handler for the /api/metrics endpoint.
 * Returns pipeline metrics in Prometheus text exposition format.
 *
 * Metrics exposed:
 *   skynet_tasks_total{status}      — Task counts by status (gauge)
 *   skynet_health_score             — Pipeline health score 0-100 (gauge)
 *   skynet_workers_active           — Currently active workers (gauge)
 *   skynet_blockers_active          — Active blockers count (gauge)
 *   skynet_events_total             — Total events recorded (counter)
 */
export function createMetricsHandler(config: SkynetConfig) {
  return async function GET(): Promise<Response> {
    const lines: string[] = [];

    try {
      const db = getSkynetDB(config.devDir);
      // Verify DB is initialized
      db.countPending();

      // --- Task counts by status ---
      const statuses = ["pending", "claimed", "completed", "failed", "blocked", "superseded"] as const;
      lines.push("# HELP skynet_tasks_total Total tasks by status");
      lines.push("# TYPE skynet_tasks_total gauge");
      for (const status of statuses) {
        const count = db.countByStatus(status);
        lines.push(`skynet_tasks_total{status="${status}"} ${count}`);
      }
      lines.push("");

      // --- Health score ---
      const maxWorkers = config.maxWorkers ?? 4;
      const healthScore = db.calculateHealthScore(maxWorkers, config.staleMinutes);
      lines.push("# HELP skynet_health_score Pipeline health score 0-100");
      lines.push("# TYPE skynet_health_score gauge");
      lines.push(`skynet_health_score ${healthScore}`);
      lines.push("");

      // --- Active workers ---
      // Count workers with status='in_progress' as active
      const activeWorkers = db.countActiveWorkers();
      lines.push("# HELP skynet_workers_active Currently active workers");
      lines.push("# TYPE skynet_workers_active gauge");
      lines.push(`skynet_workers_active ${activeWorkers}`);
      lines.push("");

      // --- Active blockers ---
      const activeBlockers = db.getActiveBlockerCount();
      lines.push("# HELP skynet_blockers_active Active blockers count");
      lines.push("# TYPE skynet_blockers_active gauge");
      lines.push(`skynet_blockers_active ${activeBlockers}`);
      lines.push("");

      // --- Total events ---
      const totalEvents = db.countEvents();
      lines.push("# HELP skynet_events_total Total events recorded");
      lines.push("# TYPE skynet_events_total counter");
      lines.push(`skynet_events_total ${totalEvents}`);
      lines.push("");
    } catch {
      // DB unavailable — return empty metrics (not 500)
      // This is valid Prometheus behavior: scrape succeeds but reports nothing
    }

    return new Response(lines.join("\n"), {
      status: 200,
      headers: {
        "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
      },
    });
  };
}
