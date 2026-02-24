import { spawnSync } from "child_process";
import { statSync, openSync, readSync, closeSync } from "fs";
import { resolve } from "path";
import type { SkynetConfig } from "../types";
import { SAFE_SCRIPT_NAME } from "../lib/constants";

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
    const rawLines = Number(url.searchParams.get("lines") ?? "200");
    const lines = Number.isFinite(rawLines)
      ? Math.min(Math.max(rawLines, 1), 1000)
      : 200;
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
    if (!SAFE_SCRIPT_NAME.test(script)) {
      return Response.json(
        { data: null, error: "Invalid script name" },
        { status: 400 }
      );
    }

    const logPath = resolve(logsDir, `${script}.log`);

    // Defense-in-depth: ensure resolved path stays within the logs directory
    // (the regex check above already prevents traversal characters, but this
    // guards against future changes to the allowedScripts set).
    if (!logPath.startsWith(resolve(logsDir) + "/") && logPath !== resolve(logsDir)) {
      return Response.json(
        { data: null, error: "Forbidden" },
        { status: 403 }
      );
    }

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
        // TS-P2-4: Add --max-count to bound grep output
        const grepResult = spawnSync("grep", ["-i", "-m", String(lines), sanitized, logPath], {
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
        // Count lines via streaming byte scan (no subprocess, ~4x less memory than wc -l)
        const fd = openSync(logPath, "r");
        try {
          const buf = Buffer.alloc(65536);
          let bytesRead: number;
          while ((bytesRead = readSync(fd, buf, 0, buf.length, null)) > 0) {
            for (let i = 0; i < bytesRead; i++) {
              if (buf[i] === 0x0a) totalLines++;
            }
          }
        } finally {
          closeSync(fd);
        }
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
