import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import type { SkynetConfig, MissionConfig } from "../types";
import { readDevFile } from "../lib/file-reader";
import { parseBody } from "../lib/parse-body";
import { logHandlerError } from "../lib/handler-error";

/**
 * Resolve which mission file to read/write.
 * If a `slug` query param is provided and .dev/missions/ exists, use that.
 * Otherwise fall back to .dev/mission.md.
 */
function resolveMissionPath(devDir: string, request?: Request): { path: string; filename: string } {
  if (request) {
    try {
      const url = new URL(request.url);
      const slug = url.searchParams.get("slug");
      if (slug && /^[a-z0-9-]+$/i.test(slug)) {
        const missionsDir = resolve(devDir, "missions");
        const filePath = resolve(missionsDir, `${slug}.md`);
        if (existsSync(filePath)) {
          return { path: filePath, filename: `missions/${slug}.md` };
        }
      }
    } catch { /* ignore URL parse errors in test environments */ }
  }

  // Check if there's an active mission in _config.json
  const configPath = resolve(devDir, "missions", "_config.json");
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, "utf-8")) as MissionConfig;
      if (config.activeMission) {
        const activePath = resolve(devDir, "missions", `${config.activeMission}.md`);
        if (existsSync(activePath)) {
          return { path: activePath, filename: `missions/${config.activeMission}.md` };
        }
      }
    } catch { /* fall through */ }
  }

  return { path: resolve(devDir, "mission.md"), filename: "mission.md" };
}

/**
 * Create GET/PUT handlers for the mission endpoint.
 * GET returns the raw contents of a mission file.
 * PUT writes new content to a mission file.
 * Supports ?slug= query param for multi-mission.
 */
export function createMissionRawHandler(config: SkynetConfig) {
  const { devDir } = config;

  async function GET(request?: Request): Promise<Response> {
    try {
      const { filename } = resolveMissionPath(devDir, request);
      const raw = readDevFile(devDir, filename);

      return Response.json({
        data: { raw },
        error: null,
      });
    } catch (err) {
      logHandlerError(devDir, "mission-raw:GET", err);
      return Response.json(
        {
          data: null,
          error:
            process.env.NODE_ENV === "development" && err instanceof Error
              ? err.message
              : "Failed to read mission.md",
        },
        { status: 500 }
      );
    }
  }

  async function PUT(request: Request): Promise<Response> {
    try {
      const { data: body, error: parseError } = await parseBody<{ raw?: string }>(request);
      if (parseError || !body) {
        return Response.json({ data: null, error: parseError || "Invalid request body" }, { status: 400 });
      }

      const { raw } = body;
      if (typeof raw !== "string") {
        return Response.json({ data: null, error: "Missing 'raw' field (string)" }, { status: 400 });
      }
      if (raw.length > 100_000) {
        return Response.json({ data: null, error: "Mission content must be 100,000 characters or fewer" }, { status: 400 });
      }

      const { path } = resolveMissionPath(devDir, request);
      writeFileSync(path, raw, "utf-8");

      return Response.json({ data: { saved: true }, error: null });
    } catch (err) {
      logHandlerError(devDir, "mission-raw:PUT", err);
      return Response.json(
        { data: null, error: err instanceof Error ? err.message : "Failed to write mission.md" },
        { status: 500 },
      );
    }
  }

  return { GET, PUT };
}
