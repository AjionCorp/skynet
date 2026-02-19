import { readFileSync, writeFileSync, readdirSync, existsSync } from "fs";
import { resolve, join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKYNET_ROOT = resolve(__dirname, "../../../..");
const PLIST_TEMPLATES_DIR = resolve(SKYNET_ROOT, "templates/launchagents");

interface SetupAgentsOptions {
  dir?: string;
  dryRun?: boolean;
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

    if (options.dryRun) {
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

  if (!options.dryRun && installed.length > 0) {
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
