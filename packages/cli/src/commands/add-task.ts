import { readFileSync, writeFileSync, renameSync, existsSync } from "fs";
import { resolve, join } from "path";
import { loadConfig } from "../utils/loadConfig";
import { acquireBacklogLock, releaseBacklogLock } from "../utils/backlogLock";
import { isSqliteReady, sqliteQuery, sqlEscape } from "../utils/sqliteQuery";

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

  // Length limits (matching dashboard validation)
  if (title.trim().length > 500) {
    console.error("Error: Title must be 500 characters or fewer.");
    process.exit(1);
  }
  if (options.description && options.description.trim().length > 2000) {
    console.error("Error: Description must be 2000 characters or fewer.");
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

  // Write to SQLite first (authoritative source)
  let sqliteOk = false;
  try {
    if (isSqliteReady(devDir)) {
      const safeTitle = sqlEscape(title.trim());
      const safeTag = sqlEscape(tag);
      const safeDesc = sqlEscape(options.description?.trim() || "");
      const root = sqlEscape(title.trim().replace(/\[[A-Z]*\]\s*/g, "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 120));
      const now = sqlEscape(new Date().toISOString());
      if (position === "top") {
        sqliteQuery(devDir, `UPDATE tasks SET priority=priority+1 WHERE status IN ('pending','claimed');`);
      }
      const pri = position === "top" ? 0 : 999;
      sqliteQuery(devDir,
        `INSERT INTO tasks (title, tag, description, status, priority, normalized_root, created_at, updated_at) ` +
        `VALUES ('${safeTitle}', '${safeTag}', '${safeDesc}', 'pending', ` +
        `${pri}, '${root}', '${now}', '${now}');`
      );
      sqliteOk = true;
    }
  } catch (err) {
    console.error(`  WARNING: SQLite write failed — falling back to file-only. Error: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Update backlog.md (from SQLite if possible, otherwise direct manipulation)
  try {
    const content = readFileSync(backlogPath, "utf-8");
    const lines = content.split("\n");

    let insertIndex = -1;
    if (position === "top") {
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].match(/^- \[[ >x]\] /)) {
          insertIndex = i;
          break;
        }
      }
    } else {
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith("- [x] ")) {
          insertIndex = i;
          break;
        }
      }
    }

    if (insertIndex === -1) {
      if (lines.length > 0 && lines[lines.length - 1] !== "") {
        lines.push("");
      }
      lines.push(taskLine);
    } else {
      lines.splice(insertIndex, 0, taskLine);
    }

    const newContent = lines.join("\n");
    const tmpPath = backlogPath + ".tmp";
    writeFileSync(tmpPath, newContent, "utf-8");
    renameSync(tmpPath, backlogPath);
  } finally {
    releaseBacklogLock(lockPath);
  }

  console.log(`\n  Added task to backlog (position: ${position}):\n`);
  console.log(`    ${taskLine}\n`);
}
