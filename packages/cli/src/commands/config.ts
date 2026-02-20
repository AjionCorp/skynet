import { readFileSync, writeFileSync, appendFileSync, renameSync, existsSync } from "fs";
import { resolve, join } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

interface ConfigOptions {
  dir?: string;
}

/** Known variable descriptions, keyed by variable name. */
const KNOWN_VARS: Record<string, string> = {
  SKYNET_PROJECT_NAME: "Project name identifier",
  SKYNET_PROJECT_DIR: "Project root directory",
  SKYNET_DEV_DIR: "Dev state directory (.dev/)",
  SKYNET_LOCK_PREFIX: "PID lock file prefix",
  SKYNET_DEV_SERVER_CMD: "Dev server start command",
  SKYNET_DEV_SERVER_URL: "Dev server URL",
  SKYNET_DEV_PORT: "Base port for dev server; workers offset from this",
  SKYNET_TYPECHECK_CMD: "Typecheck command",
  SKYNET_LINT_CMD: "Lint command",
  SKYNET_GATE_1: "Quality gate 1",
  SKYNET_GATE_2: "Quality gate 2",
  SKYNET_GATE_3: "Quality gate 3",
  SKYNET_PLAYWRIGHT_DIR: "Playwright test directory",
  SKYNET_SMOKE_TEST: "Smoke test spec file",
  SKYNET_FEATURE_TEST: "Feature test spec file",
  SKYNET_BRANCH_PREFIX: "Git branch prefix",
  SKYNET_MAIN_BRANCH: "Main git branch name",
  SKYNET_MAX_WORKERS: "Max parallel workers",
  SKYNET_MAX_TASKS_PER_RUN: "Max tasks per worker run",
  SKYNET_STALE_MINUTES: "Minutes before task is stale",
  SKYNET_MAX_FIX_ATTEMPTS: "Max auto-fix attempts",
  SKYNET_MAX_LOG_SIZE_KB: "Max log file size (KB)",
  SKYNET_AUTH_TOKEN_CACHE: "Auth token cache path",
  SKYNET_AUTH_FAIL_FLAG: "Auth failure flag path",
  SKYNET_AUTH_KEYCHAIN_SERVICE: "Keychain service name",
  SKYNET_AUTH_KEYCHAIN_ACCOUNT: "Keychain account name",
  SKYNET_AUTH_NOTIFY_INTERVAL: "Auth notify interval (seconds)",
  SKYNET_CODEX_NOTIFY_INTERVAL: "Codex auth notify interval (seconds)",
  SKYNET_CODEX_REFRESH_BUFFER_SECS: "Codex refresh buffer (seconds)",
  SKYNET_CODEX_OAUTH_ISSUER: "Override Codex OAuth issuer (advanced)",
  SKYNET_NOTIFY_CHANNELS: "Notification channels",
  SKYNET_TG_ENABLED: "Telegram notifications enabled",
  SKYNET_TG_BOT_TOKEN: "Telegram bot token",
  SKYNET_TG_CHAT_ID: "Telegram chat ID",
  SKYNET_SLACK_WEBHOOK_URL: "Slack webhook URL",
  SKYNET_DISCORD_WEBHOOK_URL: "Discord webhook URL",
  SKYNET_CLAUDE_BIN: "Claude binary path",
  SKYNET_CLAUDE_FLAGS: "Claude CLI flags",
  SKYNET_AGENT_PLUGIN: "Agent plugin (auto|claude|codex|path)",
  SKYNET_CODEX_BIN: "Codex binary path",
  SKYNET_CODEX_SUBCOMMAND: "Codex subcommand to run (exec recommended for non-interactive)",
  SKYNET_CODEX_FLAGS: "Codex CLI flags",
  SKYNET_EXTRA_PATH: "Additional PATH entries",
  SKYNET_ERROR_ENV_KEYS: "Env vars to scan in server logs",
  SKYNET_AGENT_TIMEOUT_MINUTES: "Max minutes before agent process is killed (default: 45)",
  SKYNET_HEALTH_ALERT_THRESHOLD: "Health score threshold for watchdog alerts (default: 50)",
  SKYNET_MAX_EVENTS_LOG_KB: "Max events.log size in KB before rotation (default: 1024)",
  SKYNET_MAX_FIXERS: "Maximum concurrent task-fixer instances (default: 3)",
  SKYNET_DRIVER_BACKLOG_THRESHOLD: "Pending task count before project-driver generates more (default: 5)",
  SKYNET_WORKER_CONTEXT: "Path to file with project-specific context injected into worker prompts",
  SKYNET_WORKER_CONVENTIONS: "Path to file with coding conventions injected into worker prompts",
  SKYNET_INSTALL_CMD: "Package install command run before quality gates (default: pnpm install --frozen-lockfile)",
  SKYNET_WATCHDOG_INTERVAL: "Seconds between watchdog monitoring cycles (default: 180)",
  SKYNET_ONE_SHOT: "Set to 1 for single-task mode — worker exits after completing one task",
  SKYNET_ONE_SHOT_TASK: "Task description for single-task mode (set automatically by skynet run)",
};

interface ParsedVar {
  name: string;
  value: string;
  lineIndex: number;
}

function getConfigPath(projectDir: string): string {
  return join(projectDir, ".dev/skynet.config.sh");
}

function readConfigFile(projectDir: string): string {
  const configPath = getConfigPath(projectDir);
  if (!existsSync(configPath)) {
    throw new Error(`skynet.config.sh not found. Run 'skynet init' first.`);
  }
  return readFileSync(configPath, "utf-8");
}

/**
 * Parse config lines matching `export VAR="value"` or `VAR="value"`.
 * Returns parsed variables with their line indices for editing.
 */
function parseConfig(content: string): ParsedVar[] {
  const vars: ParsedVar[] = [];
  const resolved: Record<string, string> = {};
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^(?:export\s+)?(\w+)="(.*)"/);
    if (match) {
      let value = match[2];
      // Resolve variable references
      value = value.replace(/\$\{?(\w+)\}?/g, (_, key) => resolved[key] || process.env[key] || "");
      resolved[match[1]] = value;
      vars.push({ name: match[1], value, lineIndex: i });
    }
  }

  return vars;
}

/**
 * Validate a value for known keys that require specific formats.
 * Returns an error message or null if valid.
 */
function validateValue(key: string, value: string, projectDir: string): string | null {
  switch (key) {
    case "SKYNET_MAX_WORKERS": {
      const n = Number(value);
      if (!Number.isInteger(n) || n <= 0) {
        return `SKYNET_MAX_WORKERS must be a positive integer (got "${value}").`;
      }
      return null;
    }
    case "SKYNET_STALE_MINUTES": {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 5) {
        return `SKYNET_STALE_MINUTES must be an integer >= 5 (got "${value}").`;
      }
      return null;
    }
    case "SKYNET_MAIN_BRANCH": {
      // Validate as a plausible git branch name using git check-ref-format
      if (!value || value.trim().length === 0) {
        return `SKYNET_MAIN_BRANCH cannot be empty.`;
      }
      try {
        execSync(`git check-ref-format --allow-onelevel "${value}"`, {
          cwd: projectDir,
          stdio: "ignore",
        });
      } catch {
        return `SKYNET_MAIN_BRANCH "${value}" is not a valid git branch name.`;
      }
      return null;
    }
    default:
      return null;
  }
}

/**
 * `skynet config list` — Display all config variables as a formatted table.
 */
export async function configListCommand(options: ConfigOptions) {
  const projectDir = resolve(options.dir || process.cwd());
  const content = readConfigFile(projectDir);
  const vars = parseConfig(content);

  if (vars.length === 0) {
    console.log("\n  No variables found in skynet.config.sh.\n");
    return;
  }

  // Calculate column widths
  const header = { name: "Variable", value: "Value", desc: "Description" };
  let nameWidth = header.name.length;
  let valueWidth = header.value.length;
  let descWidth = header.desc.length;

  const rows = vars.map((v) => {
    const desc = KNOWN_VARS[v.name] || "";
    // Truncate long values for display
    const displayValue = v.value.length > 50 ? v.value.substring(0, 47) + "..." : v.value;
    nameWidth = Math.max(nameWidth, v.name.length);
    valueWidth = Math.max(valueWidth, displayValue.length);
    descWidth = Math.max(descWidth, desc.length);
    return { name: v.name, value: displayValue, desc };
  });

  // Cap column widths
  valueWidth = Math.min(valueWidth, 50);
  descWidth = Math.min(descWidth, 40);

  const sep = `  ${"─".repeat(nameWidth + 2)}┼${"─".repeat(valueWidth + 2)}┼${"─".repeat(descWidth + 2)}`;

  console.log(`\n  Skynet Configuration (${getConfigPath(projectDir)})\n`);
  console.log(`  ${header.name.padEnd(nameWidth)}  │ ${header.value.padEnd(valueWidth)} │ ${header.desc.padEnd(descWidth)}`);
  console.log(sep);

  for (const row of rows) {
    console.log(`  ${row.name.padEnd(nameWidth)}  │ ${row.value.padEnd(valueWidth)} │ ${row.desc.padEnd(descWidth)}`);
  }

  console.log("");
}

/**
 * `skynet config get KEY` — Show a single variable's value.
 */
export async function configGetCommand(key: string, options: ConfigOptions) {
  if (!key || key.trim().length === 0) {
    console.error("Error: KEY is required.");
    process.exit(1);
  }

  const projectDir = resolve(options.dir || process.cwd());
  const content = readConfigFile(projectDir);
  const vars = parseConfig(content);

  const found = vars.find((v) => v.name === key);
  if (!found) {
    console.error(`\n  Error: Variable "${key}" not found in skynet.config.sh.\n`);
    process.exit(1);
  }

  console.log(found.value);
}

/**
 * `skynet config set KEY VALUE` — Update a variable's value with atomic write.
 */
export async function configSetCommand(key: string, value: string, options: ConfigOptions) {
  if (!key || key.trim().length === 0) {
    console.error("Error: KEY is required.");
    process.exit(1);
  }
  if (value === undefined || value === null) {
    console.error("Error: VALUE is required.");
    process.exit(1);
  }

  const projectDir = resolve(options.dir || process.cwd());
  const configPath = getConfigPath(projectDir);
  const content = readConfigFile(projectDir);
  const lines = content.split("\n");

  // Find the line containing this key
  let targetLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(?:export\s+)?(\w+)="/);
    if (match && match[1] === key) {
      targetLine = i;
      break;
    }
  }

  if (targetLine === -1) {
    console.error(`\n  Error: Variable "${key}" not found in skynet.config.sh.\n`);
    process.exit(1);
  }

  // Validate the new value for known keys
  const validationError = validateValue(key, value, projectDir);
  if (validationError) {
    console.error(`\n  Validation error: ${validationError}\n`);
    process.exit(1);
  }

  // Replace the value on the target line, preserving export prefix and comments
  const line = lines[targetLine];
  const hasExport = line.startsWith("export ");
  const prefix = hasExport ? "export " : "";

  // Preserve any inline comment after the closing quote
  const commentMatch = line.match(/"[^"]*"\s*(#.*)$/);
  const inlineComment = commentMatch ? `  ${commentMatch[1]}` : "";

  lines[targetLine] = `${prefix}${key}="${value}"${inlineComment}`;

  // Atomic write: write to .tmp then rename
  const tmpPath = configPath + ".tmp";
  writeFileSync(tmpPath, lines.join("\n"), "utf-8");
  renameSync(tmpPath, configPath);

  console.log(`\n  Updated ${key}="${value}"\n`);
}

/**
 * Resolve the template directory — same strategy as init.ts.
 * When installed from npm, templates/ is two levels up from dist/commands/.
 * In monorepo dev, fall back to the repo root (four levels up).
 */
function resolveTemplateDir(): string {
  const pkgPath = fileURLToPath(new URL("../../templates", import.meta.url));
  if (existsSync(pkgPath)) return pkgPath;
  return resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../..", "templates");
}

/**
 * Extract variable names defined in a config file (lines matching `export VAR=` or `VAR=`).
 */
function extractVarNames(content: string): Set<string> {
  const names = new Set<string>();
  for (const line of content.split("\n")) {
    const m = line.match(/^(?:export\s+)?(\w+)=/);
    if (m) names.add(m[1]);
  }
  return names;
}

/**
 * Parse the template into blocks — each block is the comment lines preceding
 * a variable definition plus the definition line itself.
 */
function parseTemplateBlocks(content: string): Array<{ varName: string; block: string }> {
  const lines = content.split("\n");
  const blocks: Array<{ varName: string; block: string }> = [];
  let commentBuffer: string[] = [];

  for (const line of lines) {
    const varMatch = line.match(/^(?:export\s+)?(\w+)=/);
    if (varMatch) {
      blocks.push({
        varName: varMatch[1],
        block: [...commentBuffer, line].join("\n"),
      });
      commentBuffer = [];
    } else if (line.startsWith("#")) {
      commentBuffer.push(line);
    } else {
      // Blank line or non-comment/non-var — reset comment buffer
      commentBuffer = [];
    }
  }

  return blocks;
}

/**
 * `skynet config migrate` — Add new config variables from the template.
 * Returns the list of added variable names (useful for programmatic callers).
 */
export async function configMigrateCommand(options: ConfigOptions): Promise<string[]> {
  const projectDir = resolve(options.dir || process.cwd());
  const configPath = getConfigPath(projectDir);

  if (!existsSync(configPath)) {
    console.error("  Error: skynet.config.sh not found. Run 'skynet init' first.");
    process.exit(1);
  }

  const templatePath = join(resolveTemplateDir(), "skynet.config.sh");
  if (!existsSync(templatePath)) {
    console.error("  Error: Template skynet.config.sh not found. Reinstall skynet-cli.");
    process.exit(1);
  }

  const userContent = readFileSync(configPath, "utf-8");
  const templateContent = readFileSync(templatePath, "utf-8");

  const userVars = extractVarNames(userContent);
  const templateBlocks = parseTemplateBlocks(templateContent);

  // Find SKYNET_* variables in the template that are missing from the user's config
  const missing = templateBlocks.filter(
    (b) => b.varName.startsWith("SKYNET_") && !userVars.has(b.varName)
  );

  if (missing.length === 0) {
    console.log("  Config is up to date");
    return [];
  }

  // Append missing variables to the user's config
  const additions = missing.map((m) => m.block).join("\n\n");
  const separator = userContent.endsWith("\n") ? "\n" : "\n\n";
  appendFileSync(configPath, separator + additions + "\n", "utf-8");

  const names = missing.map((m) => m.varName);
  console.log(`  Added ${names.length} new config variable${names.length > 1 ? "s" : ""}: ${names.join(", ")}`);
  return names;
}
