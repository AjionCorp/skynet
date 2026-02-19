import { readFileSync, existsSync } from "fs";
import { execSync } from "child_process";
import { homedir, platform } from "os";
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
 * Convert a cron schedule expression to an approximate interval in seconds.
 * Handles common patterns: step minutes/hours, specific hours, comma-separated.
 */
function cronToIntervalSeconds(schedule: string): number | null {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

  // Monthly or yearly schedules — fall back to null
  if (month !== "*" || dayOfMonth !== "*" || dayOfWeek !== "*") return null;

  // Every N minutes: */N * * * *
  const minStep = minute.match(/^\*\/(\d+)$/);
  if (minStep && hour === "*") {
    return Number(minStep[1]) * 60;
  }

  // Every N hours at minute 0: 0 */N * * *
  const hourStep = hour.match(/^\*\/(\d+)$/);
  if (hourStep && minute === "0") {
    return Number(hourStep[1]) * 3600;
  }

  // Specific hours with comma: 0 8,20 * * * → count gaps
  if (minute === "0" && hour.includes(",")) {
    const hours = hour.split(",").map(Number);
    if (hours.some(isNaN)) return null;
    return Math.round((24 / hours.length) * 3600);
  }

  // Hourly: 0 * * * *
  if (minute === "0" && hour === "*") {
    return 3600;
  }

  // Specific single hour: 0 8 * * * → daily
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour)) {
    return 86400;
  }

  return null;
}

/**
 * Parse a cron schedule expression into interval seconds and a human-readable
 * description.  Returns null when the expression cannot be interpreted.
 */
function parseCronSchedule(
  expr: string,
): { intervalSeconds: number; human: string } | null {
  const intervalSeconds = cronToIntervalSeconds(expr);
  if (intervalSeconds === null) return null;

  const parts = expr.trim().split(/\s+/);
  const [minute, hour] = parts;

  let human: string;

  const minStep = minute.match(/^\*\/(\d+)$/);
  const hourStep = hour.match(/^\*\/(\d+)$/);

  if (minStep && hour === "*") {
    const n = Number(minStep[1]);
    human = n === 1 ? "Every minute" : `Every ${n} minutes`;
  } else if (hourStep && minute === "0") {
    const n = Number(hourStep[1]);
    human = n === 1 ? "Every hour" : `Every ${n} hours`;
  } else if (minute === "0" && hour.includes(",")) {
    const hours = hour.split(",").map(Number);
    const fmt = hours.map(
      (h) => `${h % 12 || 12}${h < 12 ? "am" : "pm"}`,
    );
    human = `Daily at ${fmt.join(" and ")}`;
  } else if (minute === "0" && hour === "*") {
    human = "Every hour";
  } else if (/^\d+$/.test(minute) && /^\d+$/.test(hour)) {
    const h = Number(hour);
    human = `Daily at ${h % 12 || 12}${h < 12 ? "am" : "pm"}`;
  } else {
    human = formatInterval(intervalSeconds);
  }

  return { intervalSeconds, human };
}

interface CronEntry {
  schedule: string;
  scriptPath: string | null;
  logPath: string | null;
}

/**
 * Parse `crontab -l` output and extract skynet entries between markers.
 */
function parseCrontab(
  projectName: string,
): Map<string, CronEntry> {
  const entries = new Map<string, CronEntry>();

  let crontab = "";
  try {
    crontab = execSync("crontab -l 2>/dev/null", {
      encoding: "utf-8",
      timeout: 5000,
    });
  } catch {
    return entries;
  }

  const BEGIN_MARKER = `# BEGIN skynet:${projectName}`;
  const END_MARKER = `# END skynet:${projectName}`;

  const beginIdx = crontab.indexOf(BEGIN_MARKER);
  const endIdx = crontab.indexOf(END_MARKER);
  if (beginIdx === -1 || endIdx === -1 || endIdx <= beginIdx) return entries;

  const block = crontab.slice(
    beginIdx + BEGIN_MARKER.length,
    endIdx,
  );

  // Match cron lines: "schedule SKYNET_DEV_DIR=... /bin/bash scriptPath >> logPath 2>&1"
  const cronLineRe =
    /^((?:\S+\s+){4}\S+)\s+.*\/bin\/bash\s+(\S+)\s+>>\s*(\S+)/;

  for (const line of block.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const m = trimmed.match(cronLineRe);
    if (!m) continue;

    const schedule = m[1];
    const fullScriptPath = m[2];
    const fullLogPath = m[3];

    // Extract agent name from script path: /path/to/watchdog.sh → watchdog
    const nameMatch = fullScriptPath.match(/([^/]+)\.sh$/);
    if (!nameMatch) continue;

    const agentName = nameMatch[1];
    // scriptPath relative to .dev/scripts/ (matching plist handler output)
    const relScript = fullScriptPath.match(/\.dev\/scripts\/(.+\.sh)$/);

    entries.set(agentName, {
      schedule,
      scriptPath: relScript ? relScript[1] : `${agentName}.sh`,
      logPath: fullLogPath,
    });
  }

  return entries;
}

/**
 * Create a GET handler for the monitoring/agents endpoint.
 * Lists LaunchAgent (macOS) or crontab (Linux) status for all workers.
 */
export function createMonitoringAgentsHandler(config: SkynetConfig) {
  const agentPrefix = config.agentPrefix ?? `com.${config.projectName}`;
  const plistDir = `${homedir()}/Library/LaunchAgents`;
  const os = platform();

  // Build agent definitions from worker config
  const agentDefs = config.workers.map((w) => ({
    label: `${agentPrefix}.${w.name}`,
    name: w.label,
    workerName: w.name,
  }));

  return async function GET(): Promise<Response> {
    try {
      if (os === "linux") {
        return getLinuxAgents(config.projectName, agentDefs);
      }
      return getDarwinAgents(agentPrefix, plistDir, agentDefs);
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

function getDarwinAgents(
  agentPrefix: string,
  plistDir: string,
  agentDefs: { label: string; name: string; workerName: string }[],
): Response {
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
}

function getLinuxAgents(
  projectName: string,
  agentDefs: { label: string; name: string; workerName: string }[],
): Response {
  const cronEntries = parseCrontab(projectName);

  const agents = agentDefs.map((agent) => {
    const entry = cronEntries.get(agent.workerName);
    const installed = !!entry;
    const parsed = entry ? parseCronSchedule(entry.schedule) : null;

    return {
      label: agent.label,
      name: agent.name,
      loaded: installed,
      lastExitStatus: null,
      pid: null,
      plistExists: installed,
      interval: parsed?.intervalSeconds ?? null,
      intervalHuman: parsed?.human ?? null,
      runAtLoad: false,
      scriptPath: entry?.scriptPath ?? null,
      logPath: entry?.logPath ?? null,
    };
  });

  return Response.json({ data: { agents }, error: null });
}
