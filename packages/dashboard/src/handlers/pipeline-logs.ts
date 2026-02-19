import { execSync, type ExecSyncOptionsWithStringEncoding } from "child_process";
import { statSync } from "fs";
import type { SkynetConfig } from "../types";

/**
 * Sanitize a search string for use in grep, stripping special characters.
 */
function sanitizeSearch(input: string): string {
  return input.replace(/[^a-zA-Z0-9 ._\-:\[\]]/g, "").slice(0, 100);
}

/**
 * Create a GET handler for the pipeline/logs endpoint.
 * Returns tail of a script's log file, with optional grep search.
 *
 * Query params:
 *   - script: name of the script (must be in worker names or allowed list)
 *   - lines: number of lines to return (default 200, max 1000)
 *   - search: optional grep filter
 */
export function createPipelineLogsHandler(config: SkynetConfig) {
  const { devDir, workers } = config;
  const scriptsDir = config.scriptsDir ?? `${devDir}/scripts`;

  // Build the allowed scripts list from worker defs + their logFiles
  const allowedScripts = new Set<string>();
  for (const w of workers) {
    allowedScripts.add(w.name);
    if (w.logFile) allowedScripts.add(w.logFile);
  }
  // Also add common extra scripts
  allowedScripts.add("post-commit-gate");
  allowedScripts.add("dev-worker");

  return async function GET(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const script = url.searchParams.get("script");
    const lines = Math.min(
      Math.max(Number(url.searchParams.get("lines") ?? "200"), 1),
      1000
    );
    const search = url.searchParams.get("search");

    if (!script || !allowedScripts.has(script)) {
      return Response.json(
        {
          data: null,
          error: `Invalid script. Allowed: ${[...allowedScripts].join(", ")}`,
        },
        { status: 400 }
      );
    }

    const logPath = `${scriptsDir}/${script}.log`;
    const execOpts: ExecSyncOptionsWithStringEncoding = {
      encoding: "utf-8",
      timeout: 5000,
    };

    try {
      let output: string;
      if (search) {
        const sanitized = sanitizeSearch(search);
        if (!sanitized) {
          return Response.json({
            data: {
              script,
              lines: [],
              totalLines: 0,
              fileSizeBytes: 0,
              count: 0,
            },
            error: null,
          });
        }
        output = execSync(
          `grep -i "${sanitized}" "${logPath}" | tail -${lines}`,
          execOpts
        );
      } else {
        output = execSync(`tail -${lines} "${logPath}"`, execOpts);
      }

      let totalLines = 0;
      let fileSizeBytes = 0;
      try {
        const wcOutput = execSync(`wc -l < "${logPath}"`, execOpts).trim();
        totalLines = Number(wcOutput) || 0;
        fileSizeBytes = statSync(logPath).size;
      } catch {
        /* ignore */
      }

      return Response.json({
        data: {
          script,
          lines: output.split("\n").filter(Boolean),
          totalLines,
          fileSizeBytes,
          count: lines,
        },
        error: null,
      });
    } catch {
      return Response.json({
        data: {
          script,
          lines: [],
          totalLines: 0,
          fileSizeBytes: 0,
          count: 0,
        },
        error: null,
      });
    }
  };
}
