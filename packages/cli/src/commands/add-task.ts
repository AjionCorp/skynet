import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { loadConfig } from "../utils/loadConfig.js";
import { isSqliteReady, sqliteQuery, sqliteRows, sqlEscape } from "../utils/sqliteQuery.js";

interface AddTaskOptions {
  dir?: string;
  tag?: string;
  description?: string;
  position?: string;
}

function getActiveMissionSlug(devDir: string): string | null {
  try {
    const configPath = resolve(devDir, "missions", "_config.json");
    const raw = readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw) as { activeMission?: string };
    const slug = config.activeMission;
    if (!slug) return null;
    const missionPath = resolve(devDir, "missions", `${slug}.md`);
    if (!existsSync(missionPath)) return null;
    return slug;
  } catch {
    return null;
  }
}

function hasMissionHashColumn(devDir: string): boolean {
  try {
    const rows = sqliteRows(devDir, "PRAGMA table_info(tasks);");
    return rows.some((row) => row[1] === "mission_hash");
  } catch {
    return false;
  }
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

  if (!isSqliteReady(devDir)) {
    console.error("Error: SQLite database not found. Run 'skynet init' first.");
    process.exit(1);
  }

  const tag = (options.tag || "FEAT").toUpperCase();
  const position = options.position || "top";

  if (position !== "top" && position !== "bottom") {
    console.error("Error: --position must be 'top' or 'bottom'.");
    process.exit(1);
  }

  // Reject newlines to prevent injection
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

  // SECURITY: All user-supplied values MUST pass through sqlEscape() before
  // interpolation into SQL string literals. sqlEscape doubles single quotes,
  // strips NUL bytes, and neutralizes newlines (preventing dot-command injection
  // in the sqlite3 CLI). The integer `pri` is safe (hardcoded 0 or 999).
  // See packages/cli/src/utils/sqliteQuery.ts for the escape implementation.
  const safeTitle = sqlEscape(title.trim());
  const safeTag = sqlEscape(tag);
  const safeDesc = sqlEscape(options.description?.trim() || "");
  const root = sqlEscape(title.trim().replace(/\[[A-Z]*\]\s*/g, "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 120));
  const now = sqlEscape(new Date().toISOString());
  const missionSlug = getActiveMissionSlug(devDir);
  const hasMissionHash = hasMissionHashColumn(devDir);
  const safeMission = hasMissionHash ? sqlEscape(missionSlug || "") : "";

  const pri = position === "top" ? 0 : 999;
  if (position === "top") {
    // Wrap in a transaction to atomically bump priorities and insert the new task
    sqliteQuery(devDir,
      `BEGIN IMMEDIATE; ` +
      `UPDATE tasks SET priority=priority+1 WHERE status IN ('pending','claimed'); ` +
      `INSERT INTO tasks (title, tag, description, status, priority, normalized_root, created_at, updated_at` +
      `${hasMissionHash ? ", mission_hash" : ""}) ` +
      `VALUES ('${safeTitle}', '${safeTag}', '${safeDesc}', 'pending', ` +
      `${pri}, '${root}', '${now}', '${now}'` +
      `${hasMissionHash ? `, '${safeMission}'` : ""}); ` +
      `COMMIT;`
    );
  } else {
    sqliteQuery(devDir,
      `INSERT INTO tasks (title, tag, description, status, priority, normalized_root, created_at, updated_at` +
      `${hasMissionHash ? ", mission_hash" : ""}) ` +
      `VALUES ('${safeTitle}', '${safeTag}', '${safeDesc}', 'pending', ` +
      `${pri}, '${root}', '${now}', '${now}'` +
      `${hasMissionHash ? `, '${safeMission}'` : ""});`
    );
  }

  const taskLine = `[${tag}] ${title.trim()}${options.description ? ` — ${options.description.trim()}` : ""}`;
  console.log(`\n  Added task to backlog (position: ${position}):\n`);
  console.log(`    ${taskLine}\n`);
}
