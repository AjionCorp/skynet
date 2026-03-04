import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import type { SkynetConfig, MissionConfig, LlmConfig } from "../types";
import { parseBody } from "../lib/parse-body";
import { logHandlerError } from "../lib/handler-error";

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
      logHandlerError(config.devDir, "mission-assignments:GET", err);
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

      const SLUG_PATTERN = /^[a-z0-9-]+$/i;
      const VALID_PROVIDERS = ["claude", "codex", "gemini", "auto"] as const;

      const missionConfig = readConfig(configPath);

      // Update active mission
      if (typeof body.activeMission === "string") {
        if (!SLUG_PATTERN.test(body.activeMission)) {
          return Response.json(
            { data: null, error: "Invalid activeMission slug format (alphanumeric and hyphens only)" },
            { status: 400 },
          );
        }
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
          if (typeof worker !== "string" || worker.length > 100 || !/^[a-zA-Z0-9_-]+$/.test(worker)) {
            return Response.json(
              { data: null, error: `Invalid worker name '${worker}' (alphanumeric, hyphens, underscores only, max 100 chars)` },
              { status: 400 },
            );
          }
          if (slug !== null && typeof slug === "string") {
            if (!SLUG_PATTERN.test(slug)) {
              return Response.json(
                { data: null, error: `Invalid mission slug '${slug}' for worker '${worker}' (alphanumeric and hyphens only)` },
                { status: 400 },
              );
            }
            const missionFile = resolve(missionsDir, `${slug}.md`);
            if (!existsSync(missionFile)) {
              return Response.json(
                { data: null, error: `Mission '${slug}' not found for worker '${worker}'` },
                { status: 404 },
              );
            }
          } else if (slug !== null) {
            return Response.json(
              { data: null, error: `Assignment for worker '${worker}' must be a string slug or null` },
              { status: 400 },
            );
          }
          missionConfig.assignments[worker] = slug;
        }
      }

      // Update per-mission LLM configs
      if (body.llmConfigs && typeof body.llmConfigs === "object") {
        if (!missionConfig.llmConfigs) missionConfig.llmConfigs = {};
        for (const [slug, llmCfg] of Object.entries(body.llmConfigs)) {
          if (!SLUG_PATTERN.test(slug)) {
            return Response.json(
              { data: null, error: `Invalid mission slug '${slug}' in llmConfigs (alphanumeric and hyphens only)` },
              { status: 400 },
            );
          }
          if (typeof llmCfg !== "object" || llmCfg === null) {
            return Response.json(
              { data: null, error: `llmConfig for '${slug}' must be an object` },
              { status: 400 },
            );
          }
          if (typeof llmCfg.provider !== "string" || !VALID_PROVIDERS.includes(llmCfg.provider as typeof VALID_PROVIDERS[number])) {
            return Response.json(
              { data: null, error: `Invalid provider for '${slug}'. Must be one of: ${VALID_PROVIDERS.join(", ")}` },
              { status: 400 },
            );
          }
          if (llmCfg.model !== undefined && (typeof llmCfg.model !== "string" || llmCfg.model.length > 100)) {
            return Response.json(
              { data: null, error: `llmConfig.model for '${slug}' must be a string (max 100 chars)` },
              { status: 400 },
            );
          }
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
      logHandlerError(config.devDir, "mission-assignments:PUT", err);
      return Response.json(
        { data: null, error: err instanceof Error ? err.message : "Failed to update assignments" },
        { status: 500 },
      );
    }
  }

  return { GET, PUT };
}
