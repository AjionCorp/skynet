import type { SkynetConfig, VelocityDataPoint } from "../types";
import { readDevFile } from "../lib/file-reader";
import { getSkynetDB } from "../lib/db";
import { parseDurationMinutes } from "./pipeline-status";

interface DateBucket {
  count: number;
  totalMins: number;
  durCount: number;
}

function bucketsToVelocity(byDate: Record<string, DateBucket>): VelocityDataPoint[] {
  return Object.entries(byDate)
    .map(([date, b]: [string, DateBucket]) => ({
      date,
      count: b.count,
      avgDurationMins: b.durCount > 0 ? Math.round(b.totalMins / b.durCount) : null,
    }))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-14);
}

/**
 * Create a GET handler for the /api/pipeline/task-velocity endpoint.
 * Returns daily task completion counts for the last 14 days.
 */
export function createTaskVelocityHandler(config: SkynetConfig) {
  const { devDir } = config;

  return async function GET(): Promise<Response> {
    try {
      let velocity: VelocityDataPoint[];

      // Try SQLite first
      try {
        const db = getSkynetDB(devDir, { readonly: true });
        const tasks = db.getCompletedTasks(500);
        const byDate: Record<string, DateBucket> = {};

        for (const task of tasks) {
          const date = task.date;
          if (!date) continue;
          if (!byDate[date]) byDate[date] = { count: 0, totalMins: 0, durCount: 0 };
          byDate[date].count++;
          const mins = parseDurationMinutes(task.duration);
          if (mins !== null) {
            byDate[date].totalMins += mins;
            byDate[date].durCount++;
          }
        }

        velocity = bucketsToVelocity(byDate);
      } catch {
        // Fall back to file-based parsing
        const completedRaw = readDevFile(devDir, "completed.md");
        const completedLines = completedRaw
          .split("\n")
          .filter(
            (l) =>
              l.startsWith("|") &&
              !l.includes("Date") &&
              !l.includes("---")
          );

        const byDate: Record<string, DateBucket> = {};
        for (const line of completedLines) {
          const parts = line.split("|").map((p) => p.trim());
          const date = parts[1] ?? "";
          if (!date) continue;
          if (!byDate[date]) byDate[date] = { count: 0, totalMins: 0, durCount: 0 };
          byDate[date].count++;
          const hasDuration = parts.length >= 7;
          const durStr = hasDuration ? (parts[4] ?? "") : "";
          const mins = parseDurationMinutes(durStr);
          if (mins !== null) {
            byDate[date].totalMins += mins;
            byDate[date].durCount++;
          }
        }

        velocity = bucketsToVelocity(byDate);
      }

      return Response.json({ data: velocity, error: null });
    } catch {
      return Response.json({ data: [], error: null });
    }
  };
}
