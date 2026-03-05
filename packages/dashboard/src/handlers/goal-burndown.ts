import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import type { SkynetConfig, MissionCriterion, MissionConfig, GoalBurndownEntry, GoalBurndownPoint, GoalBurndownResponse } from "../types";
import { readDevFile } from "../lib/file-reader";
import { getSkynetDB } from "../lib/db";
import { logHandlerError } from "../lib/handler-error";

/**
 * Extract a named section from mission.md.
 */
function extractSection(raw: string, sectionName: string): string {
  const escaped = sectionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^## ${escaped}\\s*$`, "im");
  const match = raw.match(pattern);
  if (!match || match.index === undefined) return "";
  const start = match.index + match[0].length;
  const nextSection = raw.indexOf("\n## ", start);
  const end = nextSection === -1 ? raw.length : nextSection;
  return raw.slice(start, end).trim();
}

/**
 * Parse checkbox/bullet items into MissionCriterion entries.
 */
function parseCriteria(sectionContent: string): MissionCriterion[] {
  const lines = sectionContent.split("\n");
  const criteria: MissionCriterion[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    const checkboxMatch = trimmed.match(/^-\s*\[([ xX>])\]\s+(.+)/);
    if (checkboxMatch) {
      criteria.push({ text: checkboxMatch[2].trim(), completed: checkboxMatch[1].toLowerCase() === "x" });
      continue;
    }
    const numberedMatch = trimmed.match(/^\d+\.\s+(.+)/);
    if (numberedMatch) {
      criteria.push({ text: numberedMatch[1].trim(), completed: false });
      continue;
    }
    const bulletMatch = trimmed.match(/^[-*]\s+(.+)/);
    if (bulletMatch && !bulletMatch[1].startsWith("The mission")) {
      criteria.push({ text: bulletMatch[1].trim(), completed: false });
    }
  }
  return criteria;
}

/** Extract significant keywords from text (words > 3 chars). */
function keywords(text: string): string[] {
  return text.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
}

/** Check if a task title fuzzy-matches a goal (≥40% keyword overlap). */
function matchesGoal(goalWords: string[], taskTitle: string): boolean {
  if (goalWords.length < 2) return false;
  const taskWords = new Set(keywords(taskTitle));
  const matchCount = goalWords.filter((w) => taskWords.has(w)).length;
  return matchCount / goalWords.length >= 0.4;
}

interface CompletedTaskWithDate {
  date: string;
  title: string;
}

/**
 * Get completed tasks with dates from DB or file fallback.
 */
function getCompletedTasksWithDates(devDir: string): CompletedTaskWithDate[] {
  // Try SQLite first
  try {
    const db = getSkynetDB(devDir, { readonly: true });
    const tasks = db.getCompletedTasks(1000);
    return tasks.map((t) => ({ date: t.date, title: t.task }));
  } catch {
    // Fall back to file-based parsing
    const completedRaw = readDevFile(devDir, "completed.md");
    if (!completedRaw) return [];
    return completedRaw
      .split("\n")
      .filter((l) => l.startsWith("|") && !l.includes("Date") && !l.includes("---"))
      .map((l) => {
        const parts = l.split("|").map((p) => p.trim());
        return { date: parts[1] ?? "", title: parts[2] ?? "" };
      })
      .filter((t) => t.date && t.title);
  }
}

/**
 * Get pending backlog items (tasks not yet completed) from DB or file.
 */
function getPendingTaskTitles(devDir: string): string[] {
  try {
    const db = getSkynetDB(devDir, { readonly: true });
    const backlog = db.getBacklogItems();
    return backlog.items
      .filter((i) => i.status === "pending")
      .map((i) => {
        // Strip tag prefix like "[FEAT] Title" → "Title"
        const match = i.text.match(/^\[.*?\]\s*(.+?)(?:\s*[—|]|$)/);
        return match ? match[1] : i.text;
      });
  } catch {
    const backlogRaw = readDevFile(devDir, "backlog.md");
    if (!backlogRaw) return [];
    return backlogRaw
      .split("\n")
      .filter((l) => l.match(/^- \[ \]/))
      .map((l) => {
        const match = l.match(/^- \[ \]\s*\[.*?\]\s*(.+)/);
        return match ? match[1].trim() : l.replace(/^- \[ \]\s*/, "").trim();
      });
  }
}

/**
 * Build per-goal burndown data with ETA estimation.
 */
function buildGoalBurndown(
  goals: MissionCriterion[],
  completedTasks: CompletedTaskWithDate[],
  pendingTitles: string[],
): GoalBurndownEntry[] {
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);

  return goals.map((goal, index) => {
    const goalWords = keywords(goal.text);

    // Find related completed tasks with their dates
    const relatedCompleted: CompletedTaskWithDate[] = [];
    for (const task of completedTasks) {
      if (matchesGoal(goalWords, task.title)) {
        relatedCompleted.push(task);
      }
    }

    // Find related pending tasks
    let relatedRemaining = 0;
    for (const title of pendingTitles) {
      if (matchesGoal(goalWords, title)) {
        relatedRemaining++;
      }
    }

    // Build cumulative burndown by date
    const byDate: Record<string, number> = {};
    for (const task of relatedCompleted) {
      if (task.date) {
        byDate[task.date] = (byDate[task.date] || 0) + 1;
      }
    }

    const sortedDates = Object.keys(byDate).sort();
    let cumulative = 0;
    const burndown: GoalBurndownPoint[] = [];
    for (const date of sortedDates) {
      cumulative += byDate[date];
      burndown.push({ date, completed: cumulative });
    }

    // Calculate velocity: tasks per day over last 7 days
    const sevenDaysAgo = new Date(now);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const sevenDaysAgoStr = sevenDaysAgo.toISOString().slice(0, 10);

    const recentCount = relatedCompleted.filter(
      (t) => t.date >= sevenDaysAgoStr && t.date <= todayStr
    ).length;
    const velocityPerDay = recentCount > 0 ? Math.round((recentCount / 7) * 100) / 100 : null;

    // ETA estimation
    let etaDate: string | null = null;
    let etaDays: number | null = null;

    if (relatedRemaining > 0 && velocityPerDay && velocityPerDay > 0) {
      const daysToComplete = Math.ceil(relatedRemaining / velocityPerDay);
      etaDays = daysToComplete;
      const eta = new Date(now);
      eta.setDate(eta.getDate() + daysToComplete);
      etaDate = eta.toISOString().slice(0, 10);
    } else if (relatedRemaining === 0 && relatedCompleted.length > 0) {
      // Goal appears done
      etaDays = 0;
      etaDate = todayStr;
    }

    return {
      goalIndex: index,
      goalText: goal.text,
      checked: goal.completed,
      relatedCompleted: relatedCompleted.length,
      relatedRemaining,
      burndown,
      velocityPerDay,
      etaDate,
      etaDays,
    };
  });
}

/**
 * Compute the overall mission ETA from per-goal ETAs.
 * The mission completes when ALL goals complete, so the overall ETA is the latest per-goal ETA.
 */
function computeOverallMissionEta(goals: GoalBurndownEntry[]): GoalBurndownResponse["overallMissionEta"] {
  if (goals.length === 0) return { etaDate: null, etaDays: null, confidence: "none" };

  const goalsWithRemaining = goals.filter((g) => g.relatedRemaining > 0);

  // If every goal is done (no remaining tasks and has completions), mission is done
  if (goalsWithRemaining.length === 0 && goals.some((g) => g.relatedCompleted > 0)) {
    const now = new Date();
    return { etaDate: now.toISOString().slice(0, 10), etaDays: 0, confidence: "high" };
  }

  // Find the latest ETA across goals
  let maxEtaDays: number | null = null;
  let maxEtaDate: string | null = null;

  for (const goal of goals) {
    if (goal.etaDays !== null && (maxEtaDays === null || goal.etaDays > maxEtaDays)) {
      maxEtaDays = goal.etaDays;
      maxEtaDate = goal.etaDate;
    }
  }

  // Confidence: high if all goals with remaining tasks have ETA, low if some do, none if none
  const goalsNeedingEta = goalsWithRemaining.length;
  const goalsHavingEta = goalsWithRemaining.filter((g) => g.etaDays !== null).length;
  let confidence: "high" | "low" | "none" = "none";
  if (goalsNeedingEta > 0 && goalsHavingEta === goalsNeedingEta) {
    confidence = "high";
  } else if (goalsHavingEta > 0) {
    confidence = "low";
  }

  return { etaDate: maxEtaDate, etaDays: maxEtaDays, confidence };
}

/**
 * Create a GET handler for the /api/admin/mission/goal-burndown endpoint.
 * Returns per-goal burndown data with ETA projections.
 */
export function createGoalBurndownHandler(config: SkynetConfig) {
  const { devDir } = config;

  return async function GET(request?: Request): Promise<Response> {
    try {
      let raw = "";
      // Support ?slug= query param for multi-mission
      if (request) {
        try {
          const url = new URL(request.url);
          const slug = url.searchParams.get("slug");
          if (slug && /^[a-z0-9-]+$/i.test(slug)) {
            raw = readDevFile(devDir, `missions/${slug}.md`);
          }
        } catch { /* ignore URL parse errors */ }
      }
      // Fall back to active mission or legacy mission.md
      if (!raw) {
        const configPath = resolve(devDir, "missions", "_config.json");
        if (existsSync(configPath)) {
          try {
            const mc = JSON.parse(readFileSync(configPath, "utf-8")) as MissionConfig;
            if (mc.activeMission) {
              raw = readDevFile(devDir, `missions/${mc.activeMission}.md`);
            }
          } catch { /* fall through */ }
        }
        if (!raw) raw = readDevFile(devDir, "mission.md");
      }

      if (!raw) {
        return Response.json({ data: { goals: [], overallMissionEta: { etaDate: null, etaDays: null, confidence: "none" as const } }, error: null });
      }

      // Parse goals
      const goalsSection = extractSection(raw, "Goals");
      const goals = parseCriteria(goalsSection);

      if (goals.length === 0) {
        return Response.json({ data: { goals: [], overallMissionEta: { etaDate: null, etaDays: null, confidence: "none" as const } }, error: null });
      }

      // Get completed tasks with dates and pending tasks
      const completedTasks = getCompletedTasksWithDates(devDir);
      const pendingTitles = getPendingTaskTitles(devDir);

      const burndownData = buildGoalBurndown(goals, completedTasks, pendingTitles);
      const overallMissionEta = computeOverallMissionEta(burndownData);

      return Response.json({ data: { goals: burndownData, overallMissionEta }, error: null });
    } catch (err) {
      logHandlerError(devDir, "goal-burndown", err);
      return Response.json(
        {
          data: null,
          error: process.env.NODE_ENV === "development"
            ? (err instanceof Error ? err.message : "Internal error")
            : "Internal server error",
        },
        { status: 500 }
      );
    }
  };
}
