import { spawnSync } from "child_process";
import { readFileSync, statSync } from "fs";
import { resolve } from "path";
import type { SkynetConfig } from "../types";

/**
 * Sanitize a search string for use as a grep fixed-string pattern.
 */
function sanitizeSearch(input: string): string {
  return input.replace(/[^a-zA-Z0-9 ._\-:]/g, "").slice(0, 100);
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
  // Log files live in .dev/scripts/, not the source scripts/ dir
  const logsDir = `${devDir}/scripts`;

  const allowedScripts = new Set<string>();
  for (const w of workers) {
    allowedScripts.add(w.name);
    if (w.logFile) allowedScripts.add(w.logFile);
  }
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

    // Validate script name (alphanumeric + hyphens only)
    if (!/^[a-z0-9-]+$/.test(script)) {
      return Response.json(
        { data: null, error: "Invalid script name" },
        { status: 400 }
      );
    }

    const logPath = resolve(logsDir, `${script}.log`);

    try {
      let output: string;

      if (search) {
        const sanitized = sanitizeSearch(search);
        if (!sanitized) {
          return Response.json({
            data: { script, lines: [], totalLines: 0, fileSizeBytes: 0, count: 0 },
            error: null,
          });
        }
        // Use spawnSync with explicit argv — no shell injection possible
        const grepResult = spawnSync("grep", ["-i", sanitized, logPath], {
          encoding: "utf-8",
          timeout: 5000,
        });
        const grepOutput = grepResult.stdout || "";
        const allLines = grepOutput.split("\n").filter(Boolean);
        output = allLines.slice(-lines).join("\n");
      } else {
        const tailResult = spawnSync("tail", ["-n", String(lines), logPath], {
          encoding: "utf-8",
          timeout: 5000,
        });
        output = tailResult.stdout || "";
      }

      let totalLines = 0;
      let fileSizeBytes = 0;
      try {
        fileSizeBytes = statSync(logPath).size;
        // Count lines by reading the file — avoids shell injection via wc
        const content = readFileSync(logPath, "utf-8");
        totalLines = content.split("\n").length;
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
        data: { script, lines: [], totalLines: 0, fileSizeBytes: 0, count: 0 },
        error: null,
      });
    }
  };
}
