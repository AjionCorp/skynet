import { mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, readdirSync } from "fs";
import { resolve, join, dirname } from "path";
import { fileURLToPath } from "url";
import { createInterface } from "readline";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKYNET_ROOT = resolve(__dirname, "../../../..");
const TEMPLATES_DIR = resolve(SKYNET_ROOT, "templates");
const SCRIPTS_DIR = resolve(SKYNET_ROOT, "scripts");

function prompt(question: string, defaultValue?: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultValue ? ` (${defaultValue})` : "";
  return new Promise((resolve) => {
    rl.question(`  ${question}${suffix}: `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || "");
    });
  });
}

interface InitOptions {
  name?: string;
  dir?: string;
  copyScripts?: boolean;
}

export async function initCommand(options: InitOptions) {
  console.log("\n  Skynet Pipeline Setup\n");

  const projectDir = resolve(options.dir || process.cwd());
  let projectName =
    options.name || (await prompt("Project name", projectDir.split("/").pop()));

  // Validate project name
  if (!/^[a-z0-9-]+$/.test(projectName)) {
    console.error("  Error: Project name must be lowercase alphanumeric with hyphens only (e.g. 'my-project')");
    process.exit(1);
  }

  const devServerCmd = await prompt("Dev server command", "pnpm dev");
  const devServerPort = await prompt("Dev server port", "3000");

  // Validate port
  const portNum = Number(devServerPort);
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    console.error("  Error: Port must be a number between 1 and 65535");
    process.exit(1);
  }
  const typecheckCmd = await prompt("Typecheck command", "pnpm typecheck");
  const lintCmd = await prompt("Lint command", "pnpm lint");
  const playwrightDir = await prompt("Playwright directory (relative, empty to skip)", "");
  const smokeTest = playwrightDir
    ? await prompt("Smoke test file", "e2e/smoke.spec.ts")
    : "";
  const featureTest = playwrightDir
    ? await prompt("Feature test file", "e2e/features.spec.ts")
    : "";
  const mainBranch = await prompt("Main branch", "main");
  const tgToken = await prompt("Telegram bot token (optional, empty to skip)", "");
  const tgChatId = tgToken ? await prompt("Telegram chat ID", "") : "";

  const devDir = join(projectDir, ".dev");
  const scriptsTarget = join(devDir, "scripts");

  console.log("\n  Creating .dev/ directory structure...\n");

  // Create directories
  mkdirSync(join(devDir, "prompts"), { recursive: true });
  mkdirSync(scriptsTarget, { recursive: true });

  // Shell-escape a value for safe embedding in bash double-quoted strings
  const shellEscape = (s: string) => s.replace(/["\\$`!]/g, "\\$&");

  // Generate skynet.config.sh from template
  let configContent = readFileSync(join(TEMPLATES_DIR, "skynet.config.sh"), "utf-8");
  configContent = configContent
    .replace("PLACEHOLDER_PROJECT_NAME", shellEscape(projectName))
    .replace("PLACEHOLDER_PROJECT_DIR", shellEscape(projectDir))
    .replace('export SKYNET_DEV_SERVER_CMD="pnpm dev"', `export SKYNET_DEV_SERVER_CMD="${shellEscape(devServerCmd)}"`)
    .replace("export SKYNET_DEV_SERVER_PORT=3000", `export SKYNET_DEV_SERVER_PORT=${portNum}`)
    .replace(
      'export SKYNET_DEV_SERVER_URL="http://localhost:3000"',
      `export SKYNET_DEV_SERVER_URL="http://localhost:${portNum}"`
    )
    .replace('export SKYNET_TYPECHECK_CMD="pnpm typecheck"', `export SKYNET_TYPECHECK_CMD="${shellEscape(typecheckCmd)}"`)
    .replace('export SKYNET_LINT_CMD="pnpm lint"', `export SKYNET_LINT_CMD="${shellEscape(lintCmd)}"`)
    .replace('export SKYNET_PLAYWRIGHT_DIR=""', `export SKYNET_PLAYWRIGHT_DIR="${shellEscape(playwrightDir)}"`)
    .replace('export SKYNET_SMOKE_TEST="e2e/smoke.spec.ts"', `export SKYNET_SMOKE_TEST="${shellEscape(smokeTest)}"`)
    .replace('export SKYNET_FEATURE_TEST="e2e/features.spec.ts"', `export SKYNET_FEATURE_TEST="${shellEscape(featureTest)}"`)
    .replace('export SKYNET_MAIN_BRANCH="main"', `export SKYNET_MAIN_BRANCH="${shellEscape(mainBranch)}"`)
    .replace("export SKYNET_TG_ENABLED=false", `export SKYNET_TG_ENABLED=${tgToken ? "true" : "false"}`)
    .replace('export SKYNET_TG_BOT_TOKEN=""', `export SKYNET_TG_BOT_TOKEN="${shellEscape(tgToken)}"`)
    .replace('export SKYNET_TG_CHAT_ID=""', `export SKYNET_TG_CHAT_ID="${shellEscape(tgChatId)}"`);;

  writeFileSync(join(devDir, "skynet.config.sh"), configContent);
  console.log("    .dev/skynet.config.sh");

  // Copy skynet.project.sh template
  const projectTemplate = readFileSync(join(TEMPLATES_DIR, "skynet.project.sh"), "utf-8");
  writeFileSync(join(devDir, "skynet.project.sh"), projectTemplate);
  console.log("    .dev/skynet.project.sh");

  // Copy markdown state files
  const stateFiles = [
    "backlog.md",
    "current-task.md",
    "completed.md",
    "failed-tasks.md",
    "blockers.md",
    "sync-health.md",
    "pipeline-status.md",
    "README.md",
  ];

  for (const file of stateFiles) {
    const templatePath = join(TEMPLATES_DIR, file);
    if (existsSync(templatePath)) {
      const content = readFileSync(templatePath, "utf-8");
      const targetPath = join(devDir, file);
      if (!existsSync(targetPath)) {
        writeFileSync(targetPath, content);
        console.log(`    .dev/${file}`);
      } else {
        console.log(`    .dev/${file} (already exists, skipped)`);
      }
    }
  }

  // Install scripts: symlink or copy
  const scriptFiles = readdirSync(SCRIPTS_DIR).filter((f) => f.endsWith(".sh"));

  if (options.copyScripts) {
    for (const file of scriptFiles) {
      const src = join(SCRIPTS_DIR, file);
      const dest = join(scriptsTarget, file);
      writeFileSync(dest, readFileSync(src, "utf-8"), { mode: 0o755 });
    }
    console.log(`    .dev/scripts/ (${scriptFiles.length} scripts copied)`);
  } else {
    // Symlink each script
    for (const file of scriptFiles) {
      const src = join(SCRIPTS_DIR, file);
      const dest = join(scriptsTarget, file);
      if (existsSync(dest)) continue;
      try {
        symlinkSync(src, dest);
      } catch {
        // Fallback to copy if symlink fails
        writeFileSync(dest, readFileSync(src, "utf-8"), { mode: 0o755 });
      }
    }
    console.log(`    .dev/scripts/ (${scriptFiles.length} scripts symlinked)`);
  }

  // Update .gitignore
  const gitignorePath = join(projectDir, ".gitignore");
  const gitignoreEntries = [
    "# Skynet pipeline",
    ".dev/skynet.config.sh",
    ".dev/scripts/*.log",
  ];

  if (existsSync(gitignorePath)) {
    const existing = readFileSync(gitignorePath, "utf-8");
    const missing = gitignoreEntries.filter((e) => !existing.includes(e));
    if (missing.length > 0) {
      writeFileSync(gitignorePath, existing.trimEnd() + "\n\n" + missing.join("\n") + "\n");
      console.log("    .gitignore (updated)");
    }
  } else {
    writeFileSync(gitignorePath, gitignoreEntries.join("\n") + "\n");
    console.log("    .gitignore (created)");
  }

  console.log(`
  Done! Next steps:

    1. Edit .dev/skynet.project.sh with your project vision and conventions
    2. Run: npx skynet setup-agents  (to install macOS LaunchAgents)
    3. Or run manually: bash .dev/scripts/watchdog.sh
    4. Add the dashboard: npm install @ajioncorp/skynet
`);
}
