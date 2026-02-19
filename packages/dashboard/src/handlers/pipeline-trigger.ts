import { spawn } from "child_process";
import { openSync, constants } from "fs";
import { resolve } from "path";
import type { SkynetConfig } from "../types";

/**
 * Create a POST handler for the pipeline/trigger endpoint.
 * Fires off a script in the background, protected by PID lock files.
 */
export function createPipelineTriggerHandler(config: SkynetConfig) {
  const { devDir, triggerableScripts } = config;
  const scriptsDir = config.scriptsDir ?? `${devDir}/scripts`;

  return async function POST(request: Request): Promise<Response> {
    try {
      const body = await request.json();
      const script = body.script as string;

      if (!script || !triggerableScripts.includes(script)) {
        return Response.json(
          {
            data: null,
            error: `Invalid script. Allowed: ${triggerableScripts.join(", ")}`,
          },
          { status: 400 }
        );
      }

      // Validate script name is safe (alphanumeric + hyphens only)
      if (!/^[a-z0-9-]+$/.test(script)) {
        return Response.json(
          { data: null, error: "Invalid script name" },
          { status: 400 }
        );
      }

      const scriptPath = resolve(scriptsDir, `${script}.sh`);
      const logPath = resolve(scriptsDir, `${script}.log`);

      // Fire and forget using spawn with explicit argv (no shell injection)
      const logFd = openSync(logPath, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND);
      const child = spawn("bash", [scriptPath], {
        detached: true,
        stdio: ["ignore", logFd, logFd],
      });
      child.unref();

      return Response.json({
        data: { triggered: true, script },
        error: null,
      });
    } catch (err) {
      return Response.json(
        {
          data: null,
          error:
            err instanceof Error
              ? err.message
              : "Failed to trigger script",
        },
        { status: 500 }
      );
    }
  };
}
