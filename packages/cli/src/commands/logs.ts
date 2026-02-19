import { readFileSync, existsSync, statSync, readdirSync, watch, openSync, readSync, closeSync } from "fs";
import { resolve, join } from "path";

interface LogsOptions {
  dir?: string;
  id?: string;
  tail?: string;
  follow?: boolean;
}

const LOG_TYPE_MAP: Record<string, string> = {
  worker: "dev-worker",
  fixer: "task-fixer",
  watchdog: "watchdog",
  "health-check": "health-check",
};

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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(1)} MB`;
}

function tailLines(content: string, n: number): string {
  const lines = content.split("\n");
  // If file ends with newline, last element is empty — exclude it from count
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.slice(-n).join("\n");
}

function listLogFiles(scriptsDir: string) {
  if (!existsSync(scriptsDir)) {
    console.error(`  Scripts directory not found: ${scriptsDir}`);
    process.exit(1);
  }

  const entries = readdirSync(scriptsDir).filter((f) => f.endsWith(".log")).sort();

  if (entries.length === 0) {
    console.log("\n  No log files found.\n");
    return;
  }

  console.log("\n  Available log files:\n");
  console.log("    %-30s  %8s  %s", "File", "Size", "Modified");
  console.log("    " + "-".repeat(60));

  for (const entry of entries) {
    const filePath = join(scriptsDir, entry);
    const stat = statSync(filePath);
    const size = formatBytes(stat.size);
    const modified = stat.mtime.toLocaleString();
    // Pad columns manually for alignment
    const name = entry.padEnd(30);
    const sizeStr = size.padStart(8);
    console.log(`    ${name}  ${sizeStr}  ${modified}`);
  }

  console.log("");
}

function followFile(filePath: string) {
  let position = statSync(filePath).size;
  const buf = Buffer.alloc(4096);

  const readNewContent = () => {
    let currentSize: number;
    try {
      currentSize = statSync(filePath).size;
    } catch {
      return;
    }

    if (currentSize <= position) {
      // File was truncated or unchanged
      if (currentSize < position) position = currentSize;
      return;
    }

    const fd = openSync(filePath, "r");
    try {
      let offset = position;
      while (offset < currentSize) {
        const bytesToRead = Math.min(buf.length, currentSize - offset);
        const bytesRead = readSync(fd, buf, 0, bytesToRead, offset);
        if (bytesRead === 0) break;
        process.stdout.write(buf.subarray(0, bytesRead));
        offset += bytesRead;
      }
      position = currentSize;
    } finally {
      closeSync(fd);
    }
  };

  const watcher = watch(filePath, () => {
    readNewContent();
  });

  // Also poll every 1s in case fs.watch misses events
  const interval = setInterval(readNewContent, 1000);

  process.on("SIGINT", () => {
    watcher.close();
    clearInterval(interval);
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    watcher.close();
    clearInterval(interval);
    process.exit(0);
  });
}

export async function logsCommand(type: string | undefined, options: LogsOptions) {
  const projectDir = resolve(options.dir || process.cwd());
  const vars = loadConfig(projectDir);

  const devDir = vars.SKYNET_DEV_DIR || `${projectDir}/.dev`;
  const scriptsDir = `${devDir}/scripts`;

  // No subcommand — list available log files
  if (!type) {
    listLogFiles(scriptsDir);
    return;
  }

  // Resolve log file name
  const baseLogName = LOG_TYPE_MAP[type];
  if (!baseLogName) {
    const available = Object.keys(LOG_TYPE_MAP).join(", ");
    console.error(`  Unknown log type: ${type}`);
    console.error(`  Available types: ${available}`);
    process.exit(1);
  }

  let logFileName: string;
  if (type === "worker") {
    const workerId = options.id || "1";
    if (!/^\d+$/.test(workerId)) {
      console.error(`  Invalid worker ID: ${workerId} (must be a number)`);
      process.exit(1);
    }
    logFileName = `${baseLogName}-${workerId}.log`;
  } else {
    logFileName = `${baseLogName}.log`;
  }

  const logPath = join(scriptsDir, logFileName);

  if (!existsSync(logPath)) {
    console.error(`  Log file not found: ${logPath}`);
    process.exit(1);
  }

  // Show tail lines
  const tailCount = parseInt(options.tail || "50", 10);
  if (isNaN(tailCount) || tailCount < 1) {
    console.error(`  Invalid --tail value: ${options.tail}`);
    process.exit(1);
  }

  const content = readFileSync(logPath, "utf-8");
  const tailed = tailLines(content, tailCount);
  if (tailed) {
    process.stdout.write(tailed + "\n");
  }

  // Follow mode
  if (options.follow) {
    followFile(logPath);
  }
}
