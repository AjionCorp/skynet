import type { SkynetConfig, MissionCriterion } from "../types";
import { readDevFile } from "../lib/file-reader";

/**
 * Extract a named section from mission.md.
 * Returns the content between `## SectionName` and the next `## ` or EOF.
 */
function extractSection(raw: string, sectionName: string): string {
  const pattern = new RegExp(
    `^## ${sectionName}\\s*$`,
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

    // Check if any completed task closely matches this criterion
    for (const task of completedTasks) {
      const matchCount = criterionWords.filter((word) =>
        task.includes(word)
      ).length;
      // If more than half of significant words match, consider it completed
      if (criterionWords.length > 0 && matchCount / criterionWords.length >= 0.5) {
        return { ...criterion, completed: true };
      }
    }

    return criterion;
  });
}

/**
 * Create a GET handler for the mission/status endpoint.
 * Parses mission.md into structured sections and cross-references with completed tasks.
 */
export function createMissionStatusHandler(config: SkynetConfig) {
  const { devDir } = config;

  return async function GET(): Promise<Response> {
    try {
      const raw = readDevFile(devDir, "mission.md");

      if (!raw) {
        return Response.json({
          data: {
            purpose: null,
            goals: [],
            successCriteria: [],
            currentFocus: null,
            completionPercentage: 0,
            raw: "",
          },
          error: null,
        });
      }

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

      // Completion percentage is based on success criteria
      const totalCriteria = successCriteria.length;
      const completedCriteria = successCriteria.filter((c) => c.completed).length;
      const completionPercentage =
        totalCriteria > 0
          ? Math.round((completedCriteria / totalCriteria) * 100)
          : 0;

      return Response.json({
        data: {
          purpose,
          goals,
          successCriteria,
          currentFocus,
          completionPercentage,
          raw,
        },
        error: null,
      });
    } catch (err) {
      return Response.json(
        {
          data: null,
          error:
            err instanceof Error
              ? err.message
              : "Failed to read mission status",
        },
        { status: 500 }
      );
    }
  };
}
