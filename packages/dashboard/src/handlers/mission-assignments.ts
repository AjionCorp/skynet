import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import type { SkynetConfig, MissionConfig, LlmConfig } from "../types";
import { parseBody } from "../lib/parse-body";

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
 * Create GET/PUT handlers for mission-to-worker assignments.
 * GET returns current config (activeMission + assignments).
 * PUT updates activeMission and/or assignments.
 */
export function createMissionAssignmentsHandler(config: SkynetConfig) {
  const { devDir } = config;
  const missionsDir = resolve(devDir, "missions");
  const configPath = resolve(missionsDir, "_config.json");

  async function GET(): Promise<Response> {
    try {
      const missionConfig = readConfig(configPath);
      return Response.json({ data: missionConfig, error: null });
    } catch (err) {
      return Response.json(
        { data: null, error: err instanceof Error ? err.message : "Failed to read assignments" },
        { status: 500 },
      );
    }
  }

  async function PUT(request: Request): Promise<Response> {
    try {
      const { data: body, error: parseError } = await parseBody<{
        activeMission?: string;
        assignments?: Record<string, string | null>;
        llmConfigs?: Record<string, LlmConfig>;
      }>(request);
      if (parseError || !body) {
        return Response.json(
          { data: null, error: parseError || "Invalid request body" },
          { status: 400 },
        );
      }

      const missionConfig = readConfig(configPath);

      // Update active mission
      if (typeof body.activeMission === "string") {
        const missionFile = resolve(missionsDir, `${body.activeMission}.md`);
        if (!existsSync(missionFile)) {
          return Response.json(
            { data: null, error: `Mission '${body.activeMission}' not found` },
            { status: 404 },
          );
        }
        missionConfig.activeMission = body.activeMission;

        // Also update the legacy .dev/mission.md symlink/copy for backward compat
        const legacyPath = resolve(devDir, "mission.md");
        const content = readFileSync(missionFile, "utf-8");
        writeFileSync(legacyPath, content, "utf-8");
      }

      // Update worker assignments
      if (body.assignments && typeof body.assignments === "object") {
        for (const [worker, slug] of Object.entries(body.assignments)) {
          if (slug !== null && typeof slug === "string") {
            const missionFile = resolve(missionsDir, `${slug}.md`);
            if (!existsSync(missionFile)) {
              return Response.json(
                { data: null, error: `Mission '${slug}' not found for worker '${worker}'` },
                { status: 404 },
              );
            }
          }
          missionConfig.assignments[worker] = slug;
        }
      }

      // Update per-mission LLM configs
      if (body.llmConfigs && typeof body.llmConfigs === "object") {
        if (!missionConfig.llmConfigs) missionConfig.llmConfigs = {};
        for (const [slug, llmCfg] of Object.entries(body.llmConfigs)) {
          const missionFile = resolve(missionsDir, `${slug}.md`);
          if (!existsSync(missionFile)) {
            return Response.json(
              { data: null, error: `Mission '${slug}' not found for llmConfig` },
              { status: 404 },
            );
          }
          missionConfig.llmConfigs[slug] = llmCfg;
        }
      }

      writeConfig(configPath, missionConfig);
      return Response.json({ data: missionConfig, error: null });
    } catch (err) {
      return Response.json(
        { data: null, error: err instanceof Error ? err.message : "Failed to update assignments" },
        { status: 500 },
      );
    }
  }

  return { GET, PUT };
}
