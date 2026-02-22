import { mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, readdirSync, statSync } from "fs";
import { resolve, join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import { createInterface } from "readline";

const __dirname = dirname(fileURLToPath(import.meta.url));

// When installed from npm, scripts/ and templates/ are at the package root
// (two levels up from dist/commands/init.js). In monorepo development, fall
// back to the monorepo root (four levels up).
function resolveAssetDir(name: string): string {
  const pkgPath = fileURLToPath(new URL(`../../${name}`, import.meta.url));
  if (existsSync(pkgPath)) return pkgPath;
  return resolve(__dirname, "../../../..", name);
}

const TEMPLATES_DIR = resolveAssetDir("templates");
const SCRIPTS_DIR = resolveAssetDir("scripts");

let nonInteractiveMode = false;

function prompt(question: string, defaultValue?: string): Promise<string> {
  // Non-interactive: use defaults when stdin is not a TTY or --non-interactive flag
  if (!process.stdin.isTTY || nonInteractiveMode) {
    return Promise.resolve(defaultValue || "");
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultValue ? ` (${defaultValue})` : "";
  return new Promise((resolve) => {
    rl.question(`  ${question}${suffix}: `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || "");
    });
  });
}

function isInteractive(): boolean {
  return !!process.stdin.isTTY && !nonInteractiveMode;
}

function generateMissionContent(purpose: string, goals: string, doneCriteria: string): string {
  // Format goals as numbered list if not already
  const goalLines = goals
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const formattedGoals = goalLines
    .map((g, i) => `${i + 1}. ${g.replace(/^\d+[\.\)]\s*/, "")}`)
    .join("\n");

  // Format success criteria as numbered list
  const criteriaLines = doneCriteria
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const formattedCriteria = criteriaLines
    .map((c, i) => `${i + 1}. ${c.replace(/^\d+[\.\)]\s*/, "")}`)
    .join("\n");

  return `# Mission

<!-- This file drives the project-driver agent. Define your project's purpose, goals, and success criteria. -->
<!-- The project-driver reads this file and generates tasks that advance the mission. -->

## Purpose

${purpose}

## Goals

${formattedGoals}

## Success Criteria

The mission is complete when:
${formattedCriteria}

## Current Focus

What should the pipeline prioritize right now?
`;
}

interface InitOptions {
  name?: string;
  dir?: string;
  copyScripts?: boolean;
  nonInteractive?: boolean;
  fromSnapshot?: string;
  force?: boolean;
}

export async function initCommand(options: InitOptions) {
  nonInteractiveMode = !!options.nonInteractive;

  // Validate we're inside a git repository
  try {
    execSync("git rev-parse --is-inside-work-tree", { stdio: "pipe" });
  } catch {
    console.error("  Error: skynet init must be run from within a git repository. Run 'git init' first.");
    process.exit(1);
  }

  // Validate the repo has at least one commit (git worktree requires it)
  try {
    execSync("git rev-parse HEAD", { stdio: "pipe" });
  } catch {
    console.error("  Error: git repository must have at least one commit. Run 'git add -A && git commit -m initial' first.");
    process.exit(1);
  }

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
    .replace("export SKYNET_DEV_PORT=3000", `export SKYNET_DEV_PORT=${portNum}`)
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
    .replace('export SKYNET_TG_CHAT_ID=""', `export SKYNET_TG_CHAT_ID="${shellEscape(tgChatId)}"`)

  const configPath = join(devDir, "skynet.config.sh");
  if (existsSync(configPath) && !options.force) {
    console.log("    Existing skynet.config.sh found — skipping (use --force to overwrite)");
  } else {
    writeFileSync(configPath, configContent);
    console.log("    .dev/skynet.config.sh");
  }

  // Copy skynet.project.sh template
  const projectShPath = join(devDir, "skynet.project.sh");
  if (existsSync(projectShPath) && !options.force) {
    console.log("    Existing skynet.project.sh found — skipping (use --force to overwrite)");
  } else {
    const projectTemplate = readFileSync(join(TEMPLATES_DIR, "skynet.project.sh"), "utf-8");
    writeFileSync(projectShPath, projectTemplate);
    console.log("    .dev/skynet.project.sh");
  }

  // Copy markdown state files
  const stateFiles = [
    "mission.md",
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

  // Copy skill templates
  const skillsDir = join(devDir, "skills");
  mkdirSync(skillsDir, { recursive: true });
  const skillsTemplateDir = join(TEMPLATES_DIR, "skills");
  if (existsSync(skillsTemplateDir)) {
    const skillFiles = readdirSync(skillsTemplateDir).filter((f: string) => f.endsWith(".md"));
    for (const file of skillFiles) {
      const targetPath = join(skillsDir, file);
      if (!existsSync(targetPath)) {
        writeFileSync(targetPath, readFileSync(join(skillsTemplateDir, file), "utf-8"));
        console.log(`    .dev/skills/${file}`);
      }
    }
  }

  // Interactive mission template generator
  if (isInteractive()) {
    const defineMission = await prompt("Would you like to define your project's mission now? (Y/n)", "Y");
    if (defineMission.toLowerCase() !== "n") {
      console.log("\n  Let's define your project's mission:\n");
      const purpose = await prompt("What does your project do? (one sentence)");
      const goals = await prompt("What are your top 3 goals? (comma-separated or one per line)");
      const doneCriteria = await prompt("What does 'done' look like? (comma-separated or one per line)");

      if (purpose || goals || doneCriteria) {
        // Split comma-separated input into lines
        const goalsText = goals.includes(",") ? goals.split(",").map((g) => g.trim()).join("\n") : goals;
        const criteriaText = doneCriteria.includes(",") ? doneCriteria.split(",").map((c) => c.trim()).join("\n") : doneCriteria;

        const missionPath = join(devDir, "mission.md");
        writeFileSync(missionPath, generateMissionContent(purpose, goalsText, criteriaText));
        console.log("    .dev/mission.md (populated with your mission)");
      }
    }
  }

  // Install scripts: symlink or copy (includes subdirectories like agents/)
  const scriptFiles = readdirSync(SCRIPTS_DIR).filter((f) => f.endsWith(".sh"));
  const scriptDirs = readdirSync(SCRIPTS_DIR).filter((f) => {
    try { return statSync(join(SCRIPTS_DIR, f)).isDirectory(); } catch { return false; }
  });

  if (options.copyScripts) {
    for (const file of scriptFiles) {
      const src = join(SCRIPTS_DIR, file);
      const dest = join(scriptsTarget, file);
      writeFileSync(dest, readFileSync(src, "utf-8"), { mode: 0o755 });
    }
    for (const dir of scriptDirs) {
      const srcDir = join(SCRIPTS_DIR, dir);
      const destDir = join(scriptsTarget, dir);
      mkdirSync(destDir, { recursive: true });
      for (const file of readdirSync(srcDir).filter((f) => f.endsWith(".sh"))) {
        writeFileSync(join(destDir, file), readFileSync(join(srcDir, file), "utf-8"), { mode: 0o755 });
      }
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
    // Symlink subdirectories (e.g. agents/)
    for (const dir of scriptDirs) {
      const src = join(SCRIPTS_DIR, dir);
      const dest = join(scriptsTarget, dir);
      if (existsSync(dest)) continue;
      try {
        symlinkSync(src, dest);
      } catch {
        // Fallback: create dir and copy files
        mkdirSync(dest, { recursive: true });
        for (const file of readdirSync(src).filter((f) => f.endsWith(".sh"))) {
          writeFileSync(join(dest, file), readFileSync(join(src, file), "utf-8"), { mode: 0o755 });
        }
      }
    }
    console.log(`    .dev/scripts/ (${scriptFiles.length} scripts + ${scriptDirs.length} dirs symlinked)`);
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

  // Restore state from snapshot if --from-snapshot was provided
  if (options.fromSnapshot) {
    const snapshotPath = resolve(options.fromSnapshot);
    if (!existsSync(snapshotPath)) {
      console.error(`\n  Error: Snapshot file not found: ${snapshotPath}`);
      process.exit(1);
    }

    let snapshot: Record<string, string>;
    try {
      const raw = readFileSync(snapshotPath, "utf-8");
      snapshot = JSON.parse(raw);
    } catch {
      console.error(`\n  Error: Failed to parse snapshot file as JSON.`);
      process.exit(1);
    }

    // Validate expected keys
    const expectedKeys = ["backlog.md", "completed.md", "failed-tasks.md", "blockers.md", "mission.md"];
    const missingKeys = expectedKeys.filter((key) => !(key in snapshot));
    if (missingKeys.length > 0) {
      console.error(`\n  Error: Snapshot is missing expected keys: ${missingKeys.join(", ")}`);
      process.exit(1);
    }

    // Write snapshot content into .dev/, skipping skynet.config.sh (machine-specific)
    let restored = 0;
    for (const [filename, content] of Object.entries(snapshot)) {
      if (filename === "skynet.config.sh") continue;
      if (typeof content !== "string") continue;
      writeFileSync(join(devDir, filename), content, "utf-8");
      restored++;
    }

    console.log(`\n  Restored ${restored} files from snapshot`);
  }

  console.log(`
  Done! Next steps:

    1. Review .dev/mission.md (edit if needed)
    2. Edit .dev/skynet.project.sh with worker conventions
    3. Run: npx skynet setup-agents  (to install macOS LaunchAgents)
    4. Or run manually: bash .dev/scripts/watchdog.sh
    5. Add the dashboard: npm install @ajioncorp/skynet
`);
}
