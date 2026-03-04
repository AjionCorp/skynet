import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { resolve } from "path";
import type { SkynetConfig, MissionConfig } from "../types";
import { parseBody } from "../lib/parse-body";

/** Read _config.json, returning defaults if missing */
function readConfig(configPath: string): MissionConfig {
  try {
    if (!existsSync(configPath)) return { activeMission: "main", assignments: {} };
    return JSON.parse(readFileSync(configPath, "utf-8")) as MissionConfig;
  } catch {
    return { activeMission: "main", assignments: {} };
  }
}

function writeConfig(configPath: string, config: MissionConfig): void {
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

/**
 * Create GET/PUT/DELETE handlers for a single mission by slug.
 * Slug is extracted from the URL path (last segment before query string).
 */
export function createMissionDetailHandler(config: SkynetConfig) {
  const { devDir } = config;
  const missionsDir = resolve(devDir, "missions");
  const configPath = resolve(missionsDir, "_config.json");

  function getSlug(request: Request): string | null {
    const url = new URL(request.url);
    // Path pattern: /api/admin/missions/{slug}
    const segments = url.pathname.split("/").filter(Boolean);
    const slug = segments[segments.length - 1];
    if (!slug || slug === "missions") return null;
    // Sanitize: only allow alphanumeric + hyphens
    if (!/^[a-z0-9-]+$/i.test(slug)) return null;
    return slug;
  }

  async function GET(request: Request): Promise<Response> {
    try {
      const slug = getSlug(request);
      if (!slug) {
        return Response.json({ data: null, error: "Missing or invalid slug" }, { status: 400 });
      }

      const filePath = resolve(missionsDir, `${slug}.md`);
      if (!existsSync(filePath)) {
        return Response.json({ data: null, error: `Mission '${slug}' not found` }, { status: 404 });
      }

      const raw = readFileSync(filePath, "utf-8");
      const missionConfig = readConfig(configPath);
      const assignedWorkers = Object.entries(missionConfig.assignments)
        .filter(([, s]) => s === slug)
        .map(([w]) => w);

      return Response.json({
        data: {
          slug,
          raw,
          isActive: missionConfig.activeMission === slug,
          assignedWorkers,
          llmConfig: missionConfig.llmConfigs?.[slug] ?? { provider: "auto" as const },
        },
        error: null,
      });
    } catch (err) {
      return Response.json(
        { data: null, error: err instanceof Error ? err.message : "Failed to read mission" },
        { status: 500 },
      );
    }
  }

  async function PUT(request: Request): Promise<Response> {
    try {
      const slug = getSlug(request);
      if (!slug) {
        return Response.json({ data: null, error: "Missing or invalid slug" }, { status: 400 });
      }

      const filePath = resolve(missionsDir, `${slug}.md`);
      if (!existsSync(filePath)) {
        return Response.json({ data: null, error: `Mission '${slug}' not found` }, { status: 404 });
      }

      const { data: body, error: parseError } = await parseBody<{ raw?: string }>(request);
      if (parseError || !body) {
        return Response.json(
          { data: null, error: parseError || "Invalid request body" },
          { status: 400 },
        );
      }

      if (typeof body.raw !== "string") {
        return Response.json(
          { data: null, error: "Missing 'raw' field (string)" },
          { status: 400 },
        );
      }
      if (body.raw.length > 100_000) {
        return Response.json(
          { data: null, error: "Mission content must be 100,000 characters or fewer" },
          { status: 400 },
        );
      }

      writeFileSync(filePath, body.raw, "utf-8");
      return Response.json({ data: { slug, saved: true }, error: null });
    } catch (err) {
      return Response.json(
        { data: null, error: err instanceof Error ? err.message : "Failed to update mission" },
        { status: 500 },
      );
    }
  }

  async function DELETE(request: Request): Promise<Response> {
    try {
      const slug = getSlug(request);
      if (!slug) {
        return Response.json({ data: null, error: "Missing or invalid slug" }, { status: 400 });
      }

      const missionConfig = readConfig(configPath);
      if (missionConfig.activeMission === slug) {
        return Response.json(
          { data: null, error: "Cannot delete the active mission. Set another mission as active first." },
          { status: 409 },
        );
      }

      const filePath = resolve(missionsDir, `${slug}.md`);
      if (!existsSync(filePath)) {
        return Response.json({ data: null, error: `Mission '${slug}' not found` }, { status: 404 });
      }

      unlinkSync(filePath);

      // Clear any worker assignments and LLM config for this mission
      let changed = false;
      for (const [worker, assigned] of Object.entries(missionConfig.assignments)) {
        if (assigned === slug) {
          missionConfig.assignments[worker] = null;
          changed = true;
        }
      }
      if (missionConfig.llmConfigs?.[slug]) {
        delete missionConfig.llmConfigs[slug];
        changed = true;
      }
      if (changed) writeConfig(configPath, missionConfig);

      return Response.json({ data: { slug, deleted: true }, error: null });
    } catch (err) {
      return Response.json(
        { data: null, error: err instanceof Error ? err.message : "Failed to delete mission" },
        { status: 500 },
      );
    }
  }

  return { GET, PUT, DELETE };
}
