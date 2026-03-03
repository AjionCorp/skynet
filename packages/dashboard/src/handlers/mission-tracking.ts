import { existsSync, readFileSync, readdirSync } from "fs";
import { resolve } from "path";
import type { SkynetConfig, MissionConfig, MissionTracking } from "../types";
import { readDevFile } from "../lib/file-reader";
import { getSkynetDB } from "../lib/db";

function readMissionConfig(devDir: string): MissionConfig {
  try {
    const configPath = resolve(devDir, "missions", "_config.json");
    if (!existsSync(configPath)) return { activeMission: "main", assignments: {} };
    return JSON.parse(readFileSync(configPath, "utf-8")) as MissionConfig;
  } catch {
    return { activeMission: "main", assignments: {} };
  }
}

function parseMissionName(raw: string, slug: string): string {
  const match = raw.match(/^#\s+(.+)/m);
  return match ? match[1].trim() : slug;
}

function countCriteria(raw: string): { total: number; met: number; percentage: number } {
  const scMatch = raw.match(/## Success Criteria\s*\n([\s\S]*?)(?:\n## |\n*$)/i);
  if (!scMatch) return { total: 0, met: 0, percentage: 0 };
  let total = 0;
  let met = 0;
  for (const line of scMatch[1].split("\n")) {
    const m = line.trim().match(/^-\s*\[([ xX])\]/);
    if (m) {
      total++;
      if (m[1].toLowerCase() === "x") met++;
    }
  }
  return { total, met, percentage: total > 0 ? Math.round((met / total) * 100) : 0 };
}

/**
 * Create a GET handler for mission/tracking endpoint.
 * Returns a summary of whether the pipeline is actively tracking toward its mission.
 */
export function createMissionTrackingHandler(config: SkynetConfig) {
  const { devDir } = config;

  return async function GET(request?: Request): Promise<Response> {
    try {
      // Determine which mission to evaluate
      let slug: string | null = null;
      if (request) {
        try {
          const url = new URL(request.url);
          slug = url.searchParams.get("slug");
        } catch { /* ignore */ }
      }

      const missionConfig = readMissionConfig(devDir);
      if (!slug) slug = missionConfig.activeMission;

      // Verify mission exists
      const missionPath = slug ? resolve(devDir, "missions", `${slug}.md`) : null;
      if (!slug || !missionPath || !existsSync(missionPath)) {
        const noMission: MissionTracking = {
          slug: "",
          name: "",
          assignedWorkers: 0,
          activeWorkers: 0,
          idleWorkers: 0,
          backlogCount: 0,
          inProgressCount: 0,
          completedCount: 0,
          completedLast24h: 0,
          failedPendingCount: 0,
          criteriaTotal: 0,
          criteriaMet: 0,
          completionPercentage: 0,
          trackingStatus: "no-mission",
          trackingMessage: "No active mission configured",
        };
        return Response.json({ data: noMission, error: null });
      }

      const raw = readFileSync(missionPath, "utf-8");
      const name = parseMissionName(raw, slug);
      const { total: criteriaTotal, met: criteriaMet, percentage: completionPercentage } = countCriteria(raw);

      // Worker assignments for this mission
      const assigned = Object.entries(missionConfig.assignments)
        .filter(([, s]) => s === slug)
        .map(([w]) => w);
      const assignedWorkers = assigned.length;

      // Task data — prefer SQLite, fall back to file counts
      let backlogCount = 0;
      let inProgressCount = 0;
      let completedCount = 0;
      let completedLast24h = 0;
      let failedPendingCount = 0;
      let activeWorkerIds: Set<number> = new Set();

      const maxW = config.maxWorkers ?? 4;

      try {
        const db = getSkynetDB(devDir, { readonly: true });
        db.countPending(); // verify DB is initialized

        const backlog = db.getBacklogItems(slug);
        backlogCount = backlog.pendingCount;
        inProgressCount = backlog.claimedCount;
        completedCount = db.getCompletedCount(slug);

        // Count completions in last 24h
        const recentCompleted = db.getCompletedTasks(100, slug);
        const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        completedLast24h = recentCompleted.filter((t) => {
          if (!t.date) return false;
          try { return new Date(t.date) >= dayAgo; } catch { return false; }
        }).length;

        const failedTasks = db.getFailedTasks(slug);
        failedPendingCount = failedTasks.filter((f) =>
          f.status.includes("pending") || f.status.startsWith("fixing-")
        ).length;

        // Check which workers are currently active
        const currentTasks = db.getAllCurrentTasks(maxW);
        for (let wid = 1; wid <= maxW; wid++) {
          const task = currentTasks[`worker-${wid}`];
          if (task && task.status === "in_progress" && task.title) {
            activeWorkerIds.add(wid);
          }
        }
      } catch {
        // SQLite unavailable — fall back to file-based approximation
        const backlogRaw = readDevFile(devDir, "backlog.md");
        const pendingLines = backlogRaw.split("\n").filter((l) => l.startsWith("- [ ]"));
        backlogCount = pendingLines.length;

        for (let wid = 1; wid <= maxW; wid++) {
          const ctRaw = readDevFile(devDir, `current-task-${wid}.md`);
          if (ctRaw && /in_progress/i.test(ctRaw)) {
            inProgressCount++;
            activeWorkerIds.add(wid);
          }
        }
      }

      // Determine how many assigned workers are currently active
      const activeWorkers = assigned.filter((w) => {
        const wMatch = w.match(/(\d+)/);
        return wMatch ? activeWorkerIds.has(Number(wMatch[1])) : false;
      }).length;
      const idleWorkers = assignedWorkers - activeWorkers;

      // Compute tracking status
      let trackingStatus: MissionTracking["trackingStatus"];
      let trackingMessage: string;

      if (assignedWorkers === 0) {
        trackingStatus = "no-workers";
        trackingMessage = `No workers assigned to "${name}"`;
      } else if (activeWorkers === 0 && inProgressCount === 0 && backlogCount === 0) {
        trackingStatus = "idle";
        trackingMessage = `${assignedWorkers} worker(s) assigned but no tasks in pipeline`;
      } else if (activeWorkers === 0 && completedLast24h === 0 && backlogCount > 0) {
        trackingStatus = "stalled";
        trackingMessage = `${backlogCount} task(s) queued but no progress in last 24h`;
      } else {
        trackingStatus = "on-track";
        const parts: string[] = [];
        if (activeWorkers > 0) parts.push(`${activeWorkers} worker(s) active`);
        if (completedLast24h > 0) parts.push(`${completedLast24h} completed today`);
        if (backlogCount > 0) parts.push(`${backlogCount} queued`);
        trackingMessage = parts.join(", ") || "Mission is being tracked";
      }

      const tracking: MissionTracking = {
        slug,
        name,
        assignedWorkers,
        activeWorkers,
        idleWorkers,
        backlogCount,
        inProgressCount,
        completedCount,
        completedLast24h,
        failedPendingCount,
        criteriaTotal,
        criteriaMet,
        completionPercentage,
        trackingStatus,
        trackingMessage,
      };

      return Response.json({ data: tracking, error: null });
    } catch (err) {
      return Response.json(
        {
          data: null,
          error: process.env.NODE_ENV === "development"
            ? (err instanceof Error ? err.message : "Internal error")
            : "Internal server error",
        },
        { status: 500 },
      );
    }
  };
}
