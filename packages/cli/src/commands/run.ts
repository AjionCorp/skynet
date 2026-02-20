import { readFileSync, existsSync } from "fs";
import { resolve, join } from "path";
import { spawn } from "child_process";

interface RunOptions {
  dir?: string;
  agent?: string;
  gate?: string;
  worker?: string;
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

export async function runCommand(task: string, options: RunOptions) {
  if (!task || task.trim().length === 0) {
    console.error("Error: Task description is required.");
    console.error('Usage: skynet run "Implement feature X" --agent claude --gate typecheck');
    process.exit(1);
  }

  const projectDir = resolve(options.dir || process.cwd());
  const vars = loadConfig(projectDir);

  const projectName = vars.SKYNET_PROJECT_NAME;
  const devDir = vars.SKYNET_DEV_DIR || `${projectDir}/.dev`;
  const scriptsDir = `${devDir}/scripts`;
  const workerScript = join(scriptsDir, "dev-worker.sh");

  if (!projectName) {
    console.error("Error: SKYNET_PROJECT_NAME not set in config.");
    process.exit(1);
  }

  if (!existsSync(workerScript)) {
    console.error("Error: dev-worker.sh not found. Run 'skynet init' first.");
    process.exit(1);
  }

  // Resolve gate command from shorthand or pass through raw command
  const gateMap: Record<string, string> = {
    typecheck: vars.SKYNET_TYPECHECK_CMD || "pnpm typecheck",
  };
  const gate = options.gate
    ? gateMap[options.gate] || options.gate
    : undefined;

  const agent = options.agent || undefined;
  const workerId = options.worker || "99";

  console.log(`\n  Skynet one-shot run (${projectName})\n`);
  console.log(`  Task:   ${task.trim()}`);
  if (agent) console.log(`  Agent:  ${agent}`);
  if (gate) console.log(`  Gate:   ${gate}`);
  console.log(`  Worker: ${workerId}`);
  console.log("");

  // Build environment for one-shot worker
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    SKYNET_DEV_DIR: devDir,
    SKYNET_ONE_SHOT: "true",
    SKYNET_ONE_SHOT_TASK: task.trim(),
    SKYNET_MAX_TASKS_PER_RUN: "1",
  };

  if (agent) {
    env.SKYNET_AGENT_PLUGIN = agent;
  }

  if (gate) {
    env.SKYNET_GATE_1 = gate;
  }

  // Spawn dev-worker in foreground (stdio: inherit for streaming output)
  const child = spawn("bash", [workerScript, workerId], {
    cwd: projectDir,
    stdio: "inherit",
    env,
  });

  const exitCode = await new Promise<number>((resolve) => {
    child.on("close", (code) => resolve(code ?? 1));
  });

  if (exitCode === 0) {
    console.log("\n  One-shot task completed successfully.\n");
  } else {
    console.error(`\n  One-shot task failed (exit code ${exitCode}).\n`);
    process.exit(exitCode);
  }
}
