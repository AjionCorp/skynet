import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync } from "fs";
import { resolve } from "path";
import type { SkynetConfig, MissionSummary, MissionConfig } from "../types";
import { parseBody } from "../lib/parse-body";

const DEFAULT_CONFIG: MissionConfig = { activeMission: "main", assignments: {} };

/** Slugify a mission name: lowercase, hyphens, no special chars */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64) || "untitled";
}

/** Extract the first heading from markdown as the mission name */
function parseName(raw: string, slug: string): string {
  const match = raw.match(/^#\s+(.+)/m);
  return match ? match[1].trim() : slug;
}

/** Read _config.json, returning defaults if missing */
function readConfig(configPath: string): MissionConfig {
  try {
    if (!existsSync(configPath)) return { ...DEFAULT_CONFIG };
    return JSON.parse(readFileSync(configPath, "utf-8")) as MissionConfig;
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/** Write _config.json atomically */
function writeConfig(configPath: string, config: MissionConfig): void {
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

/**
 * Auto-migrate from single .dev/mission.md to .dev/missions/ directory.
 * Idempotent — skips if missions dir already exists.
 */
function ensureMissionsDir(devDir: string): string {
  const missionsDir = resolve(devDir, "missions");
  if (existsSync(missionsDir)) return missionsDir;

  mkdirSync(missionsDir, { recursive: true });

  const legacyMission = resolve(devDir, "mission.md");
  if (existsSync(legacyMission)) {
    copyFileSync(legacyMission, resolve(missionsDir, "main.md"));
  }

  const configPath = resolve(missionsDir, "_config.json");
  writeConfig(configPath, { ...DEFAULT_CONFIG });

  return missionsDir;
}

/**
 * Create GET/POST handlers for multi-mission management.
 * GET returns list of all missions with metadata.
 * POST creates a new mission.
 */
export function createMissionsHandler(config: SkynetConfig) {
  const { devDir } = config;

  async function GET(): Promise<Response> {
    try {
      const missionsDir = ensureMissionsDir(devDir);
      const configPath = resolve(missionsDir, "_config.json");
      const missionConfig = readConfig(configPath);

      const files = readdirSync(missionsDir).filter(
        (f) => f.endsWith(".md") && !f.startsWith("_")
      );

      const missions: (MissionSummary & { completionPercentage: number })[] = files.map((f) => {
        const slug = f.replace(/\.md$/, "");
        const raw = readFileSync(resolve(missionsDir, f), "utf-8");
        const name = parseName(raw, slug);
        const assignedWorkers = Object.entries(missionConfig.assignments)
          .filter(([, s]) => s === slug)
          .map(([w]) => w);

        // Calculate completion percentage
        const match = raw.match(/^## Success Criteria\s*$([\s\S]+?)(?=\n## |$)/im);
        let completionPercentage = 0;
        if (match) {
          const lines = match[1].split("\n");
          let total = 0;
          let done = 0;
          for (const line of lines) {
            const trimmed = line.trim();
            const checkboxMatch = trimmed.match(/^-\s*\[([ xX])\]/);
            if (checkboxMatch) {
              total++;
              if (checkboxMatch[1].toLowerCase() === "x") done++;
            }
          }
          if (total > 0) completionPercentage = Math.round((done / total) * 100);
        }

        return {
          slug,
          name,
          isActive: missionConfig.activeMission === slug,
          assignedWorkers,
          completionPercentage,
        };
      });

      return Response.json({
        data: { missions, config: missionConfig },
        error: null,
      });
    } catch (err) {
      return Response.json(
        { data: null, error: err instanceof Error ? err.message : "Failed to list missions" },
        { status: 500 },
      );
    }
  }

  async function POST(request: Request): Promise<Response> {
    try {
      const { data: body, error: parseError } = await parseBody<{
        name?: string;
        content?: string;
      }>(request);
      if (parseError || !body) {
        return Response.json(
          { data: null, error: parseError || "Invalid request body" },
          { status: 400 },
        );
      }

      const { name, content } = body;
      if (typeof name !== "string" || !name.trim()) {
        return Response.json(
          { data: null, error: "Missing 'name' field (string)" },
          { status: 400 },
        );
      }

      const slug = slugify(name);
      const missionsDir = ensureMissionsDir(devDir);
      const filePath = resolve(missionsDir, `${slug}.md`);

      if (existsSync(filePath)) {
        return Response.json(
          { data: null, error: `Mission '${slug}' already exists` },
          { status: 409 },
        );
      }

      const missionContent =
        typeof content === "string" && content.trim()
          ? content
          : `# ${name.trim()}\n\n## Purpose\n\n## Goals\n- [ ] \n\n## Success Criteria\n- [ ] \n\n## Current Focus\n`;

      writeFileSync(filePath, missionContent, "utf-8");

      return Response.json({ data: { slug, name: name.trim() }, error: null }, { status: 201 });
    } catch (err) {
      return Response.json(
        { data: null, error: err instanceof Error ? err.message : "Failed to create mission" },
        { status: 500 },
      );
    }
  }

  return { GET, POST };
}
