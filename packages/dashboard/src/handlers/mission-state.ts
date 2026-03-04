import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import type { SkynetConfig, MissionConfig, MissionState } from "../types";
import { readDevFile } from "../lib/file-reader";
import { parseBody } from "../lib/parse-body";
import { logHandlerError } from "../lib/handler-error";

const VALID_STATES: MissionState[] = ["ACTIVE", "PAUSED", "COMPLETE"];

/**
 * Parse the `## State: VALUE` line from the mission file.
 * Also supports legacy `State: VALUE` format (without `##` heading prefix).
 */
function parseState(raw: string): MissionState | null {
  const match = raw.match(/^(?:## )?State:\s*(.+)/im);
  return match ? match[1].trim() : null;
}

/**
 * Resolve which mission file to read/write.
 * If a `slug` query param is provided, use that mission file.
 * Otherwise fall back to active mission or .dev/mission.md.
 */
function resolveMissionPath(devDir: string, request?: Request): { path: string; filename: string } {
  if (request) {
    try {
      const url = new URL(request.url);
      const slug = url.searchParams.get("slug");
      if (slug && /^[a-z0-9-]+$/i.test(slug)) {
        const filePath = resolve(devDir, "missions", `${slug}.md`);
        if (existsSync(filePath)) {
          return { path: filePath, filename: `missions/${slug}.md` };
        }
      }
    } catch { /* ignore URL parse errors in test environments */ }
  }

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
 * Create GET/POST handlers for the mission/state endpoint.
 * GET returns the current state of the mission.
 * POST updates the state line in the mission file.
 */
export function createMissionStateHandler(config: SkynetConfig) {
  const { devDir } = config;

  async function GET(request?: Request): Promise<Response> {
    try {
      const { filename } = resolveMissionPath(devDir, request);
      const raw = readDevFile(devDir, filename);

      const state = raw ? parseState(raw) : null;
      return Response.json({ data: { state }, error: null });
    } catch (err) {
      logHandlerError(devDir, "mission-state:GET", err);
      return Response.json(
        {
          data: null,
          error: process.env.NODE_ENV === "development" && err instanceof Error
            ? err.message
            : "Failed to read mission state",
        },
        { status: 500 },
      );
    }
  }

  async function POST(request: Request): Promise<Response> {
    try {
      const { data: body, error: parseError } = await parseBody<{ state?: string }>(request);
      if (parseError || !body) {
        return Response.json({ data: null, error: parseError || "Invalid request body" }, { status: 400 });
      }

      const { state } = body;
      if (typeof state !== "string" || !state.trim()) {
        return Response.json({ data: null, error: "Missing 'state' field (string)" }, { status: 400 });
      }

      const trimmed = state.trim();
      if (!VALID_STATES.includes(trimmed as MissionState)) {
        return Response.json(
          { data: null, error: `Invalid state '${trimmed}'. Valid states: ${VALID_STATES.join(", ")}` },
          { status: 400 },
        );
      }

      const { path } = resolveMissionPath(devDir, request);
      const raw = existsSync(path) ? readFileSync(path, "utf-8") : "";

      let updated: string;
      const stateLineRegex = /^(?:## )?State:\s*.+$/im;
      if (stateLineRegex.test(raw)) {
        updated = raw.replace(stateLineRegex, `## State: ${trimmed}`);
      } else {
        // Insert state line after the first heading (# Title) or at the top
        const firstHeadingEnd = raw.match(/^# .+$/m);
        if (firstHeadingEnd && firstHeadingEnd.index !== undefined) {
          const insertPos = firstHeadingEnd.index + firstHeadingEnd[0].length;
          updated = raw.slice(0, insertPos) + `\n## State: ${trimmed}` + raw.slice(insertPos);
        } else {
          updated = `## State: ${trimmed}\n${raw}`;
        }
      }

      writeFileSync(path, updated, "utf-8");
      return Response.json({ data: { state: trimmed }, error: null });
    } catch (err) {
      logHandlerError(devDir, "mission-state:POST", err);
      return Response.json(
        { data: null, error: err instanceof Error ? err.message : "Failed to update mission state" },
        { status: 500 },
      );
    }
  }

  return { GET, POST };
}
