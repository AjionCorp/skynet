import { readFileSync, writeFileSync, readdirSync, existsSync } from "fs";
import { resolve, join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import { platform } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));

// When installed from npm, templates/ is at the package root (two levels up
// from dist/commands/setup-agents.js). In monorepo development, fall back to
// the monorepo root (four levels up).
function resolveAssetDir(name: string): string {
  const pkgPath = fileURLToPath(new URL(`../../${name}`, import.meta.url));
  if (existsSync(pkgPath)) return pkgPath;
  return resolve(__dirname, "../../../..", name);
}

const PLIST_TEMPLATES_DIR = resolve(resolveAssetDir("templates"), "launchagents");

interface SetupAgentsOptions {
  dir?: string;
  dryRun?: boolean;
  cron?: boolean;
}

// Cron schedule for each agent, keyed by the agent name extracted from plist filenames
const CRON_SCHEDULES: Record<string, { schedule: string; description: string }> = {
  "watchdog":           { schedule: "*/3 * * * *",   description: "Watchdog (every 3 min)" },
  "health-check":       { schedule: "0 8 * * *",     description: "Health check (daily at 8am)" },
  "auth-refresh":       { schedule: "0 * * * *",     description: "Auth refresh (hourly)" },
  "dev-worker":         { schedule: "*/15 * * * *",  description: "Dev worker (every 15 min)" },
  "task-fixer":         { schedule: "*/30 * * * *",  description: "Task fixer (every 30 min)" },
  "ui-tester":          { schedule: "0 * * * *",     description: "UI tester (hourly)" },
  "feature-validator":  { schedule: "0 */2 * * *",   description: "Feature validator (every 2 hours)" },
  "sync-runner":        { schedule: "0 */6 * * *",   description: "Sync runner (every 6 hours)" },
  "project-driver":     { schedule: "0 8,20 * * *",  description: "Project driver (8am and 8pm)" },
};

function detectScheduler(forceCron: boolean): "launchd" | "cron" {
  if (forceCron) return "cron";
  return platform() === "darwin" ? "launchd" : "cron";
}

/** Extract agent name from plist template filename: com.skynet.PROJECT.<name>.plist -> <name> */
function agentNameFromTemplate(filename: string): string {
  return filename.replace(/^com\.skynet\.PROJECT\./, "").replace(/\.plist$/, "");
}

function loadConfig(projectDir: string): Record<string, string> {
  const configPath = join(projectDir, ".dev/skynet.config.sh");
  if (!existsSync(configPath)) {
    throw new Error(`skynet.config.sh not found at ${configPath}. Run 'skynet init' first.`);
  }

  // Parse bash exports into key-value pairs
  const content = readFileSync(configPath, "utf-8");
  const vars: Record<string, string> = {};

  for (const line of content.split("\n")) {
    const match = line.match(/^export\s+(\w+)="(.*)"/);
    if (match) {
      let value = match[2];
      // Resolve variable references like $SKYNET_PROJECT_NAME
      value = value.replace(/\$\{?(\w+)\}?/g, (_, key) => vars[key] || process.env[key] || "");
      vars[match[1]] = value;
    }
  }

  return vars;
}

function setupLaunchd(
  projectName: string,
  devDir: string,
  scriptsDir: string,
  dryRun: boolean,
) {
  const launchAgentsDir = join(process.env.HOME || "~", "Library/LaunchAgents");
  if (!existsSync(PLIST_TEMPLATES_DIR)) {
    console.error("Error: LaunchAgent templates not found.");
    process.exit(1);
  }

  console.log(`\n  Installing LaunchAgents for project: ${projectName}\n`);

  const templates = readdirSync(PLIST_TEMPLATES_DIR).filter((f) => f.endsWith(".plist"));
  const installed: string[] = [];

  for (const template of templates) {
    let content = readFileSync(join(PLIST_TEMPLATES_DIR, template), "utf-8");

    // Replace all placeholders
    content = content
      .replace(/SKYNET_PROJECT_NAME/g, projectName)
      .replace(/SKYNET_SCRIPTS_DIR/g, scriptsDir)
      .replace(/SKYNET_DEV_DIR/g, devDir);

    const plistName = template.replace("PROJECT", projectName);
    const plistPath = join(launchAgentsDir, plistName);

    if (dryRun) {
      console.log(`  [dry-run] Would write: ${plistPath}`);
      console.log(content);
      console.log("---");
    } else {
      // Unload existing agent if loaded
      try {
        execSync(`launchctl unload "${plistPath}" 2>/dev/null`, { stdio: "ignore" });
      } catch {
        // Not loaded, that's fine
      }

      writeFileSync(plistPath, content);
      installed.push(plistPath);
      console.log(`    ${plistPath}`);
    }
  }

  if (!dryRun && installed.length > 0) {
    console.log("\n  Loading agents...\n");
    for (const plist of installed) {
      try {
        execSync(`launchctl load "${plist}"`, { stdio: "inherit" });
        console.log(`    Loaded: ${plist.split("/").pop()}`);
      } catch {
        console.error(`    Failed to load: ${plist.split("/").pop()}`);
      }
    }

    console.log(`\n  All agents loaded. Run 'launchctl list | grep skynet' to verify.\n`);
  }
}

function setupCron(
  projectName: string,
  devDir: string,
  scriptsDir: string,
  dryRun: boolean,
) {
  if (!existsSync(PLIST_TEMPLATES_DIR)) {
    console.error("Error: LaunchAgent templates not found.");
    process.exit(1);
  }

  console.log(`\n  Installing crontab entries for project: ${projectName}\n`);

  const BEGIN_MARKER = `# BEGIN skynet:${projectName}`;
  const END_MARKER = `# END skynet:${projectName}`;

  // Build crontab entries from the plist template filenames
  const templates = readdirSync(PLIST_TEMPLATES_DIR).filter((f) => f.endsWith(".plist"));
  const entries: string[] = [];

  for (const template of templates) {
    const agentName = agentNameFromTemplate(template);
    const cronDef = CRON_SCHEDULES[agentName];
    if (!cronDef) {
      console.error(`  Warning: no cron schedule defined for agent '${agentName}', skipping.`);
      continue;
    }

    const logPath = `${devDir}/scripts/${agentName}.log`;
    const scriptPath = `${scriptsDir}/${agentName}.sh`;

    entries.push(`# ${cronDef.description}`);
    entries.push(
      `${cronDef.schedule} SKYNET_DEV_DIR=${devDir} /bin/bash ${scriptPath} >> ${logPath} 2>&1`,
    );
  }

  const cronBlock = [BEGIN_MARKER, ...entries, END_MARKER].join("\n");

  if (dryRun) {
    console.log("  [dry-run] Would install crontab entries:\n");
    console.log(cronBlock);
    console.log("");
    return;
  }

  // Read existing crontab
  let existingCrontab = "";
  try {
    existingCrontab = execSync("crontab -l 2>/dev/null", { encoding: "utf-8" });
  } catch {
    // No existing crontab, that's fine
  }

  // Remove any previous skynet block for this project
  const blockRegex = new RegExp(
    `${BEGIN_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n[\\s\\S]*?${END_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n?`,
  );
  existingCrontab = existingCrontab.replace(blockRegex, "");

  // Append new block
  const newCrontab = existingCrontab.trimEnd() + "\n" + cronBlock + "\n";

  // Install via crontab -
  execSync("crontab -", { input: newCrontab, stdio: ["pipe", "inherit", "inherit"] });

  for (const template of templates) {
    const agentName = agentNameFromTemplate(template);
    if (CRON_SCHEDULES[agentName]) {
      console.log(`    ${CRON_SCHEDULES[agentName].description}`);
    }
  }

  console.log(`\n  All cron entries installed. Run 'crontab -l | grep skynet' to verify.\n`);
}

export async function setupAgentsCommand(options: SetupAgentsOptions) {
  const projectDir = resolve(options.dir || process.cwd());
  const vars = loadConfig(projectDir);

  const projectName = vars.SKYNET_PROJECT_NAME;
  const devDir = vars.SKYNET_DEV_DIR || `${projectDir}/.dev`;
  const scriptsDir = `${devDir}/scripts`;

  if (!projectName) {
    console.error("Error: SKYNET_PROJECT_NAME not set in config.");
    process.exit(1);
  }

  const scheduler = detectScheduler(options.cron ?? false);

  if (scheduler === "launchd") {
    setupLaunchd(projectName, devDir, scriptsDir, options.dryRun ?? false);
  } else {
    setupCron(projectName, devDir, scriptsDir, options.dryRun ?? false);
  }
}
