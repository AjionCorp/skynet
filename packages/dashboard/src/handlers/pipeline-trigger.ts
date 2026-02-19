import { exec } from "child_process";
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

      const scriptPath = `${scriptsDir}/${script}.sh`;
      const logPath = `${scriptsDir}/${script}.log`;

      // Fire and forget -- scripts have PID locks to prevent overlap
      exec(`nohup bash "${scriptPath}" >> "${logPath}" 2>&1 &`);

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
