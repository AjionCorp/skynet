import { spawn } from "child_process";
import { openSync, constants } from "fs";
import { resolve } from "path";
import type { SkynetConfig } from "../types";
import { parseBody } from "../lib/parse-body";

/**
 * Create a POST handler for the pipeline/trigger endpoint.
 * Fires off a script in the background, protected by PID lock files.
 */
export function createPipelineTriggerHandler(config: SkynetConfig) {
  const { devDir, triggerableScripts } = config;
  const scriptsDir = config.scriptsDir ?? `${devDir}/scripts`;

  return async function POST(request: Request): Promise<Response> {
    try {
      const { data: body, error: parseError, status: parseStatus } = await parseBody<{ script: string; args?: string[] }>(request);
      if (parseError || !body) {
        return Response.json({ data: null, error: parseError }, { status: parseStatus ?? 400 });
      }
      const script = body.script;
      const args = body.args ?? [];

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

      // Validate args are safe (alphanumeric + hyphens only)
      for (const arg of args) {
        if (!/^[a-z0-9-]+$/.test(arg)) {
          return Response.json(
            { data: null, error: "Invalid argument" },
            { status: 400 }
          );
        }
      }

      const scriptPath = resolve(scriptsDir, `${script}.sh`);
      // Logs go to devDir/scripts/ (e.g. .dev/scripts/), not the source scriptsDir
      const logDir = resolve(devDir, "scripts");
      const logSuffix = args.length > 0 ? `${script}-${args[0]}` : script;
      const logPath = resolve(logDir, `${logSuffix}.log`);

      // Fire and forget using spawn with explicit argv (no shell injection)
      const logFd = openSync(logPath, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND);
      const child = spawn("bash", [scriptPath, ...args], {
        detached: true,
        stdio: ["ignore", logFd, logFd],
        env: { ...process.env, SKYNET_DEV_DIR: devDir },
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
