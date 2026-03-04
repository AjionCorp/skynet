import type { SkynetConfig, MissionState, PipelineExplainState } from "../types";
import { readDevFile } from "../lib/file-reader";
import { getSkynetDB } from "../lib/db";
import { logHandlerError } from "../lib/handler-error";

/**
 * Parse the `## State: VALUE` line from the mission file.
 */
function parseState(raw: string): MissionState | null {
  const match = raw.match(/^(?:## )?State:\s*(.+)/im);
  return match ? match[1].trim() : null;
}

/**
 * Parse checked/unchecked items from a mission section (Goals or Success Criteria).
 */
function parseCriteria(raw: string, section: string): { checked: number; unchecked: string[] } {
  const pattern = new RegExp(`## ${section}\\s*\\n([\\s\\S]*?)(?:\\n## |\\n*$)`, "i");
  const match = raw.match(pattern);
  if (!match) return { checked: 0, unchecked: [] };

  const lines = match[1].split("\n").filter((l) => /^\s*- \[/.test(l));
  let checked = 0;
  const unchecked: string[] = [];
  for (const line of lines) {
    if (/- \[x\]/i.test(line)) {
      checked++;
    } else {
      unchecked.push(line.replace(/^\s*- \[.\]\s*/, "").trim());
    }
  }
  return { checked, unchecked };
}

/**
 * Count completed tasks in the last 24 hours.
 */
function countVelocity24h(devDir: string): number {
  const today = new Date().toISOString().slice(0, 10);

  try {
    const db = getSkynetDB(devDir, { readonly: true });
    const tasks = db.getCompletedTasks(200);
    return tasks.filter((t) => t.date === today).length;
  } catch {
    // Fall back to file parsing
    const raw = readDevFile(devDir, "completed.md");
    return raw
      .split("\n")
      .filter(
        (l) =>
          l.startsWith("|") &&
          !l.includes("Date") &&
          !l.includes("---") &&
          l.includes(today),
      ).length;
  }
}

/**
 * Count active failures by error category.
 */
function countActiveFailures(devDir: string): Record<string, number> {
  const PATTERN_RULES: Array<{ test: RegExp; label: string }> = [
    { test: /merge conflict/i, label: "merge conflict" },
    { test: /typecheck fail/i, label: "typecheck failure" },
    { test: /usage limit/i, label: "usage limits" },
    { test: /claude exit code/i, label: "claude exit code" },
    { test: /timeout/i, label: "timeout" },
  ];

  function classify(error: string): string {
    for (const rule of PATTERN_RULES) {
      if (rule.test.test(error)) return rule.label;
    }
    return error.length > 0 ? "other" : "unknown";
  }

  const counts: Record<string, number> = {};

  try {
    const db = getSkynetDB(devDir, { readonly: true });
    const rows = db.getFailedTasksWithWorker();
    const active = rows.filter(
      (r) => r.status === "failed" || r.status.startsWith("fixing-"),
    );
    for (const r of active) {
      const cat = classify(r.error);
      counts[cat] = (counts[cat] || 0) + 1;
    }
  } catch {
    const raw = readDevFile(devDir, "failed-tasks.md");
    const lines = raw
      .split("\n")
      .filter(
        (l) =>
          l.startsWith("|") && !l.includes("Date") && !l.includes("---"),
      );
    for (const line of lines) {
      const parts = line.split("|").map((p) => p.trim());
      const status = parts[7] ?? "";
      if (status === "failed" || status.startsWith("fixing-")) {
        const cat = classify(parts[4] ?? "");
        counts[cat] = (counts[cat] || 0) + 1;
      }
    }
  }

  return counts;
}

/**
 * Get top active blockers (max 3).
 */
function getTopBlockers(devDir: string): string[] {
  try {
    const db = getSkynetDB(devDir, { readonly: true });
    return db.getActiveBlockerLines().slice(0, 3);
  } catch {
    const raw = readDevFile(devDir, "blockers.md");
    // Extract lines under ## Active heading
    const activeMatch = raw.match(/## Active\s*\n([\s\S]*?)(?:\n## |\n*$)/i);
    if (!activeMatch) return [];
    return activeMatch[1]
      .split("\n")
      .filter((l) => l.startsWith("- "))
      .map((l) => l.replace(/^- /, "").trim())
      .slice(0, 3);
  }
}

/**
 * Build a natural-language summary from the explain state.
 */
function buildSummary(s: Omit<PipelineExplainState, "summary">): string {
  const parts: string[] = [];

  const stateLabel = s.state ? s.state.toLowerCase() : "unknown";
  parts.push(`Pipeline is ${stateLabel} at ${s.completionPct}% completion.`);

  if (s.velocity24h > 0) {
    parts.push(`${s.velocity24h} task${s.velocity24h === 1 ? "" : "s"} completed today.`);
  } else {
    parts.push("No tasks completed today.");
  }

  const failureTotal = Object.values(s.activeFailures).reduce((a, b) => a + b, 0);
  if (failureTotal > 0) {
    parts.push(`${failureTotal} active failure${failureTotal === 1 ? "" : "s"}.`);
  }

  if (s.topBlockers.length > 0) {
    parts.push(`${s.topBlockers.length} active blocker${s.topBlockers.length === 1 ? "" : "s"}.`);
  }

  if (s.lagGoals.length > 0) {
    parts.push(`${s.lagGoals.length} goal${s.lagGoals.length === 1 ? "" : "s"} not yet met.`);
  }

  return parts.join(" ");
}

/**
 * Create a GET handler for /api/admin/pipeline/explain.
 * Returns a structured explanation of the current pipeline state.
 */
export function createPipelineExplainHandler(config: SkynetConfig) {
  const { devDir } = config;

  return async function GET(): Promise<Response> {
    try {
      // Read mission file
      const missionRaw = readDevFile(devDir, "mission.md");

      const state = missionRaw ? parseState(missionRaw) : null;

      // Parse goals and success criteria
      const goals = parseCriteria(missionRaw, "Goals");
      const criteria = parseCriteria(missionRaw, "Success Criteria");

      // Completion percentage based on checked goals + criteria
      const totalItems = goals.checked + goals.unchecked.length + criteria.checked + criteria.unchecked.length;
      const checkedItems = goals.checked + criteria.checked;
      const completionPct = totalItems > 0 ? Math.round((checkedItems / totalItems) * 100) : 0;

      // Lagging goals (unchecked from both sections)
      const lagGoals = [...goals.unchecked, ...criteria.unchecked];

      const topBlockers = getTopBlockers(devDir);
      const activeFailures = countActiveFailures(devDir);
      const velocity24h = countVelocity24h(devDir);

      const data: Omit<PipelineExplainState, "summary"> = {
        state,
        completionPct,
        lagGoals,
        topBlockers,
        activeFailures,
        velocity24h,
      };

      const result: PipelineExplainState = {
        ...data,
        summary: buildSummary(data),
      };

      return Response.json({ data: result, error: null });
    } catch (err) {
      logHandlerError(devDir, "pipeline-explain:GET", err);
      return Response.json(
        {
          data: null,
          error:
            process.env.NODE_ENV === "development" && err instanceof Error
              ? err.message
              : "Failed to explain pipeline state",
        },
        { status: 500 },
      );
    }
  };
}
