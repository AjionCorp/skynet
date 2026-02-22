import { readFileSync, writeFileSync, renameSync, existsSync } from "fs";
import { resolve, join } from "path";
import { loadConfig } from "../utils/loadConfig";
import { acquireBacklogLock, releaseBacklogLock } from "../utils/backlogLock";

interface AddTaskOptions {
  dir?: string;
  tag?: string;
  description?: string;
  position?: string;
}

export async function addTaskCommand(title: string, options: AddTaskOptions) {
  if (!title || title.trim().length === 0) {
    console.error("Error: Task title is required.");
    process.exit(1);
  }

  const projectDir = resolve(options.dir || process.cwd());
  const vars = loadConfig(projectDir);
  if (!vars) {
    console.error("skynet.config.sh not found. Run 'skynet init' first.");
    process.exit(1);
  }
  const devDir = vars.SKYNET_DEV_DIR || `${projectDir}/.dev`;
  const backlogPath = join(devDir, "backlog.md");

  if (!existsSync(backlogPath)) {
    console.error(`Error: backlog.md not found at ${backlogPath}. Run 'skynet init' first.`);
    process.exit(1);
  }

  const tag = (options.tag || "FEAT").toUpperCase();
  const position = options.position || "top";

  if (position !== "top" && position !== "bottom") {
    console.error("Error: --position must be 'top' or 'bottom'.");
    process.exit(1);
  }

  // Reject newlines to prevent markdown injection into backlog
  if (/[\n\r]/.test(title) || (options.description && /[\n\r]/.test(options.description))) {
    console.error("Error: Title and description must not contain newlines.");
    process.exit(1);
  }

  // Build the task line
  let taskLine = `- [ ] [${tag}] ${title.trim()}`;
  if (options.description) {
    taskLine += ` — ${options.description.trim()}`;
  }

  // Derive lock path from config (same as shell: ${SKYNET_LOCK_PREFIX}-backlog.lock)
  const projectName = vars.SKYNET_PROJECT_NAME || "unknown";
  const lockPrefix = vars.SKYNET_LOCK_PREFIX || `/tmp/skynet-${projectName}`;
  const lockPath = `${lockPrefix}-backlog.lock`;

  if (!acquireBacklogLock(lockPath)) {
    console.error("Error: Could not acquire backlog lock. Another process may be modifying backlog.md.");
    process.exit(1);
  }

  try {
    const content = readFileSync(backlogPath, "utf-8");
    const lines = content.split("\n");

    // Find insertion point:
    //   - After header comments (lines starting with # or <!-- or blank lines at top)
    //   - position=top: insert before the first task entry (pending, claimed, or done)
    //   - position=bottom: insert before the first [x] (done) block
    let insertIndex = -1;

    if (position === "top") {
      // Insert before the first task line (any checkbox entry)
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].match(/^- \[[ >x]\] /)) {
          insertIndex = i;
          break;
        }
      }
    } else {
      // position=bottom: insert before the first [x] entry
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith("- [x] ")) {
          insertIndex = i;
          break;
        }
      }
    }

    if (insertIndex === -1) {
      // No existing entries found — append at end
      // Ensure there's a trailing newline before appending
      if (lines.length > 0 && lines[lines.length - 1] !== "") {
        lines.push("");
      }
      lines.push(taskLine);
    } else {
      lines.splice(insertIndex, 0, taskLine);
    }

    const newContent = lines.join("\n");

    // Atomic write: write to .tmp then rename
    const tmpPath = backlogPath + ".tmp";
    writeFileSync(tmpPath, newContent, "utf-8");
    renameSync(tmpPath, backlogPath);
  } finally {
    releaseBacklogLock(lockPath);
  }

  console.log(`\n  Added task to backlog (position: ${position}):\n`);
  console.log(`    ${taskLine}\n`);
}
