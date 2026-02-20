import { readFileSync, existsSync } from "fs";
import { resolve, join } from "path";

interface MetricsOptions {
  dir?: string;
}

function loadConfig(projectDir: string): Record<string, string> {
  const configPath = join(projectDir, ".dev/skynet.config.sh");
  if (!existsSync(configPath)) {
    throw new Error(`skynet.config.sh not found. Run 'skynet init' first.`);
  }

  const content = readFileSync(configPath, "utf-8");
  const vars: Record<string, string> = {};

  for (const line of content.split("\n")) {
    const match = line.match(/^export\s+(\w+)="(.*)"/);
    if (match) {
      let value = match[2];
      value = value.replace(/\$\{?(\w+)\}?/g, (_, key) => vars[key] || process.env[key] || "");
      vars[match[1]] = value;
    }
  }

  return vars;
}

function readFile(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

/**
 * Parse duration string ("Nm" or "Nh Mm") to minutes.
 * Returns NaN if unparseable.
 */
function parseDurationMinutes(dur: string): number {
  const trimmed = dur.trim();

  // "Nh Mm" format
  const hmMatch = trimmed.match(/^(\d+)h\s+(\d+)m$/);
  if (hmMatch) {
    return Number(hmMatch[1]) * 60 + Number(hmMatch[2]);
  }

  // "Nh" format (no minutes)
  const hOnly = trimmed.match(/^(\d+)h$/);
  if (hOnly) {
    return Number(hOnly[1]) * 60;
  }

  // "Nm" format
  const mMatch = trimmed.match(/^(\d+)m$/);
  if (mMatch) {
    return Number(mMatch[1]);
  }

  return NaN;
}

function padRight(str: string, len: number): string {
  return str.length >= len ? str : str + " ".repeat(len - str.length);
}

function padLeft(str: string, len: number): string {
  return str.length >= len ? str : " ".repeat(len - str.length) + str;
}

export async function metricsCommand(options: MetricsOptions) {
  const projectDir = resolve(options.dir || process.cwd());
  const vars = loadConfig(projectDir);
  const devDir = vars.SKYNET_DEV_DIR || `${projectDir}/.dev`;

  console.log("\n  Skynet Pipeline Metrics\n");

  // ──────────────────────────────────────────
  // Completed tasks analysis
  // ──────────────────────────────────────────
  const completedContent = readFile(join(devDir, "completed.md"));
  const completedRows = completedContent
    .split("\n")
    .filter((l) => l.startsWith("|") && !l.includes("| Date |") && !l.includes("---"));

  const totalCompleted = completedRows.length;

  // Parse durations and tags
  const durations: number[] = [];
  const tagCounts: Record<string, number> = {
    "[FEAT]": 0,
    "[FIX]": 0,
    "[TEST]": 0,
    "[INFRA]": 0,
    "[DOCS]": 0,
  };

  for (const row of completedRows) {
    const cols = row.split("|").map((c) => c.trim()).filter(Boolean);

    // Detect whether Duration column is present.
    // 4 cols = Date | Task | Branch | Notes
    // 5 cols = Date | Task | Branch | Duration | Notes
    if (cols.length >= 5) {
      const durStr = cols[3];
      const mins = parseDurationMinutes(durStr);
      if (!isNaN(mins)) {
        durations.push(mins);
      }
    }

    // Tag detection from the Task column (cols[1])
    const task = cols[1] || "";
    for (const tag of Object.keys(tagCounts)) {
      if (task.includes(tag)) {
        tagCounts[tag]++;
        break;
      }
    }
  }

  // Compute averages
  const avgDuration = durations.length > 0
    ? durations.reduce((a, b) => a + b, 0) / durations.length
    : 0;
  const totalMinutes = durations.reduce((a, b) => a + b, 0);
  const tasksPerHour = totalMinutes > 0
    ? (durations.length / (totalMinutes / 60))
    : 0;

  // Format average duration
  function formatMinutes(m: number): string {
    if (m < 1) return "< 1m";
    const hours = Math.floor(m / 60);
    const mins = Math.round(m % 60);
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
  }

  // ──────────────────────────────────────────
  // Completed Tasks Summary
  // ──────────────────────────────────────────
  console.log("  Completed Tasks");
  console.log("  ───────────────────────────────────────");
  console.log(`  Total completed:     ${totalCompleted}`);
  if (durations.length > 0) {
    console.log(`  Average duration:    ${formatMinutes(avgDuration)}`);
    console.log(`  Tasks per hour:      ${tasksPerHour.toFixed(1)}`);
    console.log(`  Tasks with duration: ${durations.length}/${totalCompleted}`);
  } else {
    console.log("  Average duration:    N/A (no duration data)");
    console.log("  Tasks per hour:      N/A");
  }

  // ──────────────────────────────────────────
  // Tasks by Tag
  // ──────────────────────────────────────────
  console.log("\n  Tasks by Tag");
  console.log("  ───────────────────────────────────────");
  console.log(`  ${padRight("Tag", 10)} ${padLeft("Count", 6)} ${padLeft("%", 6)}`);
  console.log(`  ${padRight("───", 10)} ${padLeft("─────", 6)} ${padLeft("──", 6)}`);

  for (const [tag, count] of Object.entries(tagCounts)) {
    const pct = totalCompleted > 0 ? Math.round((count / totalCompleted) * 100) : 0;
    console.log(`  ${padRight(tag, 10)} ${padLeft(String(count), 6)} ${padLeft(pct + "%", 6)}`);
  }

  // Count untagged
  const taggedTotal = Object.values(tagCounts).reduce((a, b) => a + b, 0);
  const untagged = totalCompleted - taggedTotal;
  if (untagged > 0) {
    const pct = Math.round((untagged / totalCompleted) * 100);
    console.log(`  ${padRight("Other", 10)} ${padLeft(String(untagged), 6)} ${padLeft(pct + "%", 6)}`);
  }

  // ──────────────────────────────────────────
  // Failed Tasks Analysis
  // ──────────────────────────────────────────
  const failedContent = readFile(join(devDir, "failed-tasks.md"));
  const failedRows = failedContent
    .split("\n")
    .filter((l) => l.startsWith("|") && !l.includes("| Date |") && !l.includes("---"));

  const totalFailed = failedRows.length;

  const statusCounts: Record<string, number> = {
    fixed: 0,
    blocked: 0,
    superseded: 0,
    pending: 0,
  };

  for (const row of failedRows) {
    for (const status of Object.keys(statusCounts)) {
      if (row.includes(`| ${status} |`)) {
        statusCounts[status]++;
        break;
      }
    }
  }

  // Fix success rate: (fixed + superseded) / (fixed + superseded + blocked)
  const selfCorrected = statusCounts.fixed + statusCounts.superseded;
  const resolved = selfCorrected + statusCounts.blocked;
  const fixRate = resolved > 0 ? Math.round((selfCorrected / resolved) * 100) : 0;

  console.log("\n  Failed Tasks");
  console.log("  ───────────────────────────────────────");
  console.log(`  Total failed:        ${totalFailed}`);
  console.log(`  ${padRight("Status", 14)} ${padLeft("Count", 6)}`);
  console.log(`  ${padRight("──────", 14)} ${padLeft("─────", 6)}`);

  for (const [status, count] of Object.entries(statusCounts)) {
    console.log(`  ${padRight(status, 14)} ${padLeft(String(count), 6)}`);
  }

  console.log(`\n  Fix success rate:    ${fixRate}% (${selfCorrected}/${resolved} resolved)`);

  console.log("");
}
