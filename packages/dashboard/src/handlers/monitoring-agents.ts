import { readFileSync, existsSync } from "fs";
import { execSync } from "child_process";
import { homedir } from "os";
import type { SkynetConfig } from "../types";

/**
 * Format seconds into a human-friendly interval string.
 */
function formatInterval(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  if (seconds < 86400) {
    const hours = Math.floor(seconds / 3600);
    return `${hours} hour${hours > 1 ? "s" : ""}`;
  }
  const days = Math.floor(seconds / 86400);
  return `${days} day${days > 1 ? "s" : ""}`;
}

/**
 * Extract key values from a LaunchAgent plist XML.
 */
function parsePlist(content: string) {
  const intervalMatch = content.match(
    /<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/
  );
  const interval = intervalMatch ? Number(intervalMatch[1]) : null;

  const runAtLoadMatch = content.match(
    /<key>RunAtLoad<\/key>\s*<(true|false)\s*\/>/
  );
  const runAtLoad = runAtLoadMatch?.[1] === "true";

  const scriptMatch = content.match(/\.dev\/scripts\/([^<]+\.sh)/);
  const scriptPath = scriptMatch?.[1] ?? null;

  const logMatch = content.match(
    /<key>StandardOutPath<\/key>\s*<string>([^<]+)<\/string>/
  );
  const logPath = logMatch?.[1] ?? null;

  return { interval, runAtLoad, scriptPath, logPath };
}

/**
 * Create a GET handler for the monitoring/agents endpoint.
 * Lists LaunchAgent status for all workers.
 */
export function createMonitoringAgentsHandler(config: SkynetConfig) {
  const agentPrefix = config.agentPrefix ?? `com.${config.projectName}`;
  const plistDir = `${homedir()}/Library/LaunchAgents`;

  // Build agent definitions from worker config
  const agentDefs = config.workers.map((w) => ({
    label: `${agentPrefix}.${w.name}`,
    name: w.label,
  }));

  return async function GET(): Promise<Response> {
    try {
      // Get loaded agents from launchctl
      const loadedAgents = new Map<
        string,
        { pid: string; exitStatus: number }
      >();
      try {
        const output = execSync("launchctl list", {
          encoding: "utf-8",
          timeout: 5000,
        });
        const prefix = agentPrefix + ".";
        for (const line of output.split("\n")) {
          const match = line.match(
            /^(-|\d+)\t(-?\d+)\t(\S+)/
          );
          if (match && match[3].startsWith(prefix)) {
            loadedAgents.set(match[3], {
              pid: match[1],
              exitStatus: Number(match[2]),
            });
          }
        }
      } catch {
        /* launchctl may fail in some contexts */
      }

      const agents = agentDefs.map((agent) => {
        const plistPath = `${plistDir}/${agent.label}.plist`;
        const plistExists = existsSync(plistPath);

        let interval: number | null = null;
        let runAtLoad = false;
        let scriptPath: string | null = null;
        let logPath: string | null = null;

        if (plistExists) {
          try {
            const content = readFileSync(plistPath, "utf-8");
            const parsed = parsePlist(content);
            interval = parsed.interval;
            runAtLoad = parsed.runAtLoad;
            scriptPath = parsed.scriptPath;
            logPath = parsed.logPath;
          } catch {
            /* ignore parse errors */
          }
        }

        const launchctlInfo = loadedAgents.get(agent.label);
        const loaded = !!launchctlInfo;

        return {
          label: agent.label,
          name: agent.name,
          loaded,
          lastExitStatus: launchctlInfo?.exitStatus ?? null,
          pid:
            launchctlInfo?.pid !== "-"
              ? (launchctlInfo?.pid ?? null)
              : null,
          plistExists,
          interval,
          intervalHuman: interval ? formatInterval(interval) : null,
          runAtLoad,
          scriptPath,
          logPath,
        };
      });

      return Response.json({ data: { agents }, error: null });
    } catch (err) {
      return Response.json(
        {
          data: null,
          error:
            err instanceof Error
              ? err.message
              : "Failed to read agent status",
        },
        { status: 500 }
      );
    }
  };
}
