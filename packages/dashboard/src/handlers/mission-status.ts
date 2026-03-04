import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import type { SkynetConfig, MissionCriterion, MissionConfig, MissionState, GoalProgress } from "../types";
import { readDevFile } from "../lib/file-reader";
import { logHandlerError } from "../lib/handler-error";

/**
 * Extract a named section from mission.md.
 * Returns the content between `## SectionName` and the next `## ` or EOF.
 */
function extractSection(raw: string, sectionName: string): string {
  const escaped = sectionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `^## ${escaped}\\s*$`,
    "im"
  );
  const match = raw.match(pattern);
  if (!match || match.index === undefined) return "";

  const start = match.index + match[0].length;
  const nextSection = raw.indexOf("\n## ", start);
  const end = nextSection === -1 ? raw.length : nextSection;
  return raw.slice(start, end).trim();
}

/**
 * Parse a section's numbered/bulleted items into MissionCriterion entries.
 * Supports:
 *   - [x] Completed item (checkbox format)
 *   - [ ] Pending item (checkbox format)
 *   1. Plain numbered item (treated as pending)
 *   - Plain bulleted item (treated as pending)
 */
function parseCriteria(sectionContent: string): MissionCriterion[] {
  const lines = sectionContent.split("\n");
  const criteria: MissionCriterion[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Checkbox format: - [x] or - [ ]
    const checkboxMatch = trimmed.match(/^-\s*\[([ xX>])\]\s+(.+)/);
    if (checkboxMatch) {
      const completed = checkboxMatch[1].toLowerCase() === "x";
      criteria.push({ text: checkboxMatch[2].trim(), completed });
      continue;
    }

    // Numbered format: 1. Item text
    const numberedMatch = trimmed.match(/^\d+\.\s+(.+)/);
    if (numberedMatch) {
      criteria.push({ text: numberedMatch[1].trim(), completed: false });
      continue;
    }

    // Bulleted format: - Item text (but not the "The mission is complete when:" preamble)
    const bulletMatch = trimmed.match(/^[-*]\s+(.+)/);
    if (bulletMatch && !bulletMatch[1].startsWith("The mission")) {
      criteria.push({ text: bulletMatch[1].trim(), completed: false });
      continue;
    }
  }

  return criteria;
}

/**
 * Parse the Purpose section — return the first non-empty paragraph.
 */
function parsePurpose(sectionContent: string): string | null {
  const text = sectionContent
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join(" ");
  return text || null;
}

/**
 * Parse the Current Focus section — return a summary string.
 */
function parseCurrentFocus(sectionContent: string): string | null {
  const text = sectionContent
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join(" ");
  return text || null;
}

/**
 * Parse the `## State: VALUE` line from the mission file.
 * Also supports legacy `State: VALUE` format (without `##` heading prefix).
 * Returns the state string (e.g. "ACTIVE", "PAUSED", "COMPLETE") or null.
 */
function parseState(raw: string): MissionState | null {
  const match = raw.match(/^(?:## )?State:\s*(.+)/im);
  return match ? match[1].trim() : null;
}

/**
 * Cross-reference criteria against completed tasks to mark matching criteria as done.
 * Uses fuzzy keyword matching: if enough words from a completed task title appear
 * in the criterion text, it's considered completed.
 */
function crossReferenceCompleted(
  criteria: MissionCriterion[],
  completedRaw: string
): MissionCriterion[] {
  // Parse completed.md table rows
  const completedTasks = completedRaw
    .split("\n")
    .filter(
      (l) =>
        l.startsWith("|") && !l.includes("Date") && !l.includes("---")
    )
    .map((l) => {
      const parts = l.split("|").map((p) => p.trim());
      return (parts[2] ?? "").toLowerCase();
    })
    .filter((t) => t.length > 0);

  if (completedTasks.length === 0) return criteria;

  return criteria.map((criterion) => {
    // Already marked as completed via checkbox
    if (criterion.completed) return criterion;

    const criterionWords = criterion.text
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 3);

    // Require at least 3 significant words to prevent false positives
    // on short criteria text that could match many unrelated tasks
    if (criterionWords.length < 3) return criterion;

    // Check if any completed task closely matches this criterion
    // using word-boundary matching (whole word, not substring)
    for (const task of completedTasks) {
      const taskWords = new Set(task.split(/\W+/).filter((w) => w.length > 3));
      const matchCount = criterionWords.filter((word) =>
        taskWords.has(word)
      ).length;
      // If more than half of significant words match, consider it completed
      if (matchCount / criterionWords.length >= 0.5) {
        return { ...criterion, completed: true };
      }
    }

    return criterion;
  });
}

/**
 * Build goal progress breakdown: for each goal, count how many completed tasks
 * have titles that match the goal's keywords (fuzzy word-boundary matching).
 */
function buildGoalProgress(
  goals: MissionCriterion[],
  completedRaw: string
): GoalProgress[] {
  const completedTasks = completedRaw
    .split("\n")
    .filter(
      (l) =>
        l.startsWith("|") && !l.includes("Date") && !l.includes("---")
    )
    .map((l) => {
      const parts = l.split("|").map((p) => p.trim());
      return (parts[2] ?? "").toLowerCase();
    })
    .filter((t) => t.length > 0);

  return goals.map((goal, index) => {
    const goalWords = goal.text
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 3);

    let relatedCount = 0;
    if (goalWords.length >= 2) {
      for (const task of completedTasks) {
        const taskWords = new Set(task.split(/\W+/).filter((w) => w.length > 3));
        const matchCount = goalWords.filter((word) => taskWords.has(word)).length;
        if (matchCount / goalWords.length >= 0.4) {
          relatedCount++;
        }
      }
    }

    return {
      goalIndex: index,
      goalText: goal.text,
      checked: goal.completed,
      relatedTasksCompleted: relatedCount,
    };
  });
}

/**
 * Create a GET handler for the mission/status endpoint.
 * Parses mission.md into structured sections and cross-references with completed tasks.
 */
export function createMissionStatusHandler(config: SkynetConfig) {
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
        } catch { /* ignore URL parse errors in test environments */ }
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
        return Response.json({
          data: {
            state: null,
            purpose: null,
            goals: [],
            successCriteria: [],
            goalProgress: [],
            currentFocus: null,
            completionPercentage: 0,
            raw: "",
          },
          error: null,
        });
      }

      // Parse state from `## State: VALUE` line
      const state = parseState(raw);

      // Parse each section
      const purposeSection = extractSection(raw, "Purpose");
      const goalsSection = extractSection(raw, "Goals");
      const criteriaSection = extractSection(raw, "Success Criteria");
      const focusSection = extractSection(raw, "Current Focus");

      const purpose = parsePurpose(purposeSection);
      let goals = parseCriteria(goalsSection);
      let successCriteria = parseCriteria(criteriaSection);
      const currentFocus = parseCurrentFocus(focusSection);

      // Cross-reference with completed tasks
      const completedRaw = readDevFile(devDir, "completed.md");
      if (completedRaw) {
        goals = crossReferenceCompleted(goals, completedRaw);
        successCriteria = crossReferenceCompleted(successCriteria, completedRaw);
      }

      // Build goal progress breakdown
      const goalProgress = buildGoalProgress(goals, completedRaw || "");

      // Completion percentage is based on success criteria
      const totalCriteria = successCriteria.length;
      const completedCriteria = successCriteria.filter((c) => c.completed).length;
      const completionPercentage =
        totalCriteria > 0
          ? Math.round((completedCriteria / totalCriteria) * 100)
          : 0;

      return Response.json({
        data: {
          state,
          purpose,
          goals,
          successCriteria,
          goalProgress,
          currentFocus,
          completionPercentage,
          raw,
        },
        error: null,
      });
    } catch (err) {
      logHandlerError(devDir, "mission-status", err);
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
