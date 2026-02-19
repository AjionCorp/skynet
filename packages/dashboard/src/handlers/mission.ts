import type { SkynetConfig, MissionData, MissionSection, MissionCriterion } from "../types";
import { readDevFile } from "../lib/file-reader";

/**
 * Parse mission.md into structured sections and extract success criteria.
 */
function parseMission(raw: string): MissionData {
  const lines = raw.split("\n");

  // Extract title from first # heading
  let title = "Mission";
  const titleMatch = lines.find((l) => /^# /.test(l));
  if (titleMatch) title = titleMatch.replace(/^# /, "").trim();

  // Parse sections
  const sections: MissionSection[] = [];
  let currentHeading = "";
  let currentLevel = 0;
  let currentLines: string[] = [];

  function flushSection() {
    if (currentHeading) {
      sections.push({
        heading: currentHeading,
        level: currentLevel,
        content: currentLines.join("\n").trim(),
      });
    }
    currentLines = [];
  }

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headingMatch) {
      flushSection();
      currentLevel = headingMatch[1].length;
      currentHeading = headingMatch[2].trim();
    } else {
      currentLines.push(line);
    }
  }
  flushSection();

  // Extract success criteria from the "Success Criteria" section
  const criteriaSection = sections.find(
    (s) => s.heading.toLowerCase().includes("success criteria")
  );

  const criteria: MissionCriterion[] = [];
  if (criteriaSection) {
    for (const line of criteriaSection.content.split("\n")) {
      // Match numbered items: "1. Text" or "- Text" or checkbox items "- [x] Text" / "- [ ] Text"
      const checkboxMatch = line.match(/^[\s]*[-*]\s+\[([ xX])\]\s+(.+)/);
      const numberedMatch = line.match(/^[\s]*\d+\.\s+(.+)/);
      const bulletMatch = line.match(/^[\s]*[-*]\s+(.+)/);

      if (checkboxMatch) {
        criteria.push({
          text: checkboxMatch[2].trim(),
          status: checkboxMatch[1] !== " " ? "done" : "pending",
        });
      } else if (numberedMatch) {
        criteria.push({
          text: numberedMatch[1].trim(),
          status: "pending",
        });
      } else if (bulletMatch && !checkboxMatch) {
        criteria.push({
          text: bulletMatch[1].trim(),
          status: "pending",
        });
      }
    }
  }

  return { raw, title, sections, criteria };
}

export function createMissionHandler(config: SkynetConfig) {
  const { devDir } = config;

  return async function GET(): Promise<Response> {
    try {
      const raw = readDevFile(devDir, "mission.md");
      const data = parseMission(raw);
      return Response.json({ data, error: null });
    } catch (err) {
      return Response.json(
        {
          data: null,
          error: err instanceof Error ? err.message : "Failed to read mission.md",
        },
        { status: 500 }
      );
    }
  };
}
