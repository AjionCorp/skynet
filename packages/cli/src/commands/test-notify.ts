import { readFileSync, existsSync } from "fs";
import { resolve, join } from "path";
import { spawnSync } from "child_process";

interface TestNotifyOptions {
  dir?: string;
  channel?: string;
}

function loadConfig(projectDir: string): Record<string, string> {
  const configPath = join(projectDir, ".dev/skynet.config.sh");
  if (!existsSync(configPath)) {
    throw new Error("skynet.config.sh not found. Run 'skynet init' first.");
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

function checkChannelConfig(channel: string, vars: Record<string, string>): string | null {
  switch (channel) {
    case "telegram":
      if (vars.SKYNET_TG_ENABLED !== "true") return "not enabled (SKYNET_TG_ENABLED != true)";
      if (!vars.SKYNET_TG_BOT_TOKEN) return "missing SKYNET_TG_BOT_TOKEN";
      if (!vars.SKYNET_TG_CHAT_ID) return "missing SKYNET_TG_CHAT_ID";
      return null;
    case "slack":
      if (!vars.SKYNET_SLACK_WEBHOOK_URL) return "missing SKYNET_SLACK_WEBHOOK_URL";
      return null;
    case "discord":
      if (!vars.SKYNET_DISCORD_WEBHOOK_URL) return "missing SKYNET_DISCORD_WEBHOOK_URL";
      return null;
    default:
      return `unknown channel: ${channel}`;
  }
}

function curlExitMessage(code: number): string {
  switch (code) {
    case 6: return "could not resolve host";
    case 7: return "connection refused";
    case 22: return "HTTP error";
    case 28: return "timeout";
    default: return `curl exit code ${code}`;
  }
}

function testChannel(
  channel: string,
  message: string,
  scriptsDir: string,
  vars: Record<string, string>,
): { ok: boolean; error?: string } {
  const scriptPath = join(scriptsDir, "notify", `${channel}.sh`);
  if (!existsSync(scriptPath)) {
    return { ok: false, error: `script not found: notify/${channel}.sh` };
  }

  const configError = checkChannelConfig(channel, vars);
  if (configError) {
    return { ok: false, error: configError };
  }

  // Build env with all config vars
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(vars)) {
    env[key] = value;
  }
  env.TEST_MESSAGE = message;

  // Source the channel script, override curl to capture the real exit code
  // (the notify functions use `|| true` which masks failures), then call the function.
  const script = [
    `source "${scriptPath}"`,
    '__real_curl="$(command -v curl)"',
    "__exit=0",
    'curl() { "$__real_curl" "$@"; __exit=$?; return $__exit; }',
    `notify_${channel} "$TEST_MESSAGE"`,
    "exit $__exit",
  ].join("\n");

  const result = spawnSync("bash", ["-c", script], {
    env,
    timeout: 15000,
    encoding: "utf-8",
  });

  if (result.signal) {
    return { ok: false, error: `killed by signal ${result.signal}` };
  }

  if (result.error) {
    return { ok: false, error: result.error.message };
  }

  if (result.status === 0) {
    return { ok: true };
  }

  return { ok: false, error: curlExitMessage(result.status ?? 1) };
}

export async function testNotifyCommand(options: TestNotifyOptions) {
  const projectDir = resolve(options.dir || process.cwd());

  let vars: Record<string, string>;
  try {
    vars = loadConfig(projectDir);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }

  const devDir = vars.SKYNET_DEV_DIR || join(projectDir, ".dev");
  const scriptsDir = join(devDir, "scripts");
  const projectName = vars.SKYNET_PROJECT_NAME || "unknown";

  // Parse configured channels
  const channelsStr = vars.SKYNET_NOTIFY_CHANNELS || "";
  const allChannels = channelsStr
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);

  if (allChannels.length === 0) {
    console.log(
      "No notification channels configured. Set SKYNET_NOTIFY_CHANNELS in skynet.config.sh"
    );
    return;
  }

  // Validate --channel flag
  if (options.channel && !allChannels.includes(options.channel)) {
    console.error(
      `Channel "${options.channel}" is not in SKYNET_NOTIFY_CHANNELS (${channelsStr})`
    );
    process.exit(1);
  }

  const channelsToTest = options.channel ? [options.channel] : allChannels;
  const message = `Skynet test notification from ${projectName} at ${new Date().toISOString()}`;

  console.log(`\nTesting notification channels for ${projectName}...\n`);

  let hasFailures = false;

  for (const channel of channelsToTest) {
    const result = testChannel(channel, message, scriptsDir, vars);
    if (result.ok) {
      console.log(`  ${channel}: OK`);
    } else {
      console.log(`  ${channel}: FAILED (${result.error})`);
      hasFailures = true;
    }
  }

  console.log("");

  if (hasFailures) {
    process.exit(1);
  }
}
