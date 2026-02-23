import { resolve } from "path";
import { spawnSync } from "child_process";
import { loadConfig } from "../utils/loadConfig.js";
import { isSqliteReady, sqliteRows, sqliteQuery } from "../utils/sqliteQuery.js";
import { sqlEscape } from "../utils/sqliteQuery.js";

interface RecoverOptions {
  dir?: string;
  dryRun?: boolean;
  force?: boolean;
}

export async function recoverGitCommand(options: RecoverOptions) {
  const projectDir = resolve(options.dir || process.cwd());
  const vars = loadConfig(projectDir);
  if (!vars) {
    console.error("skynet.config.sh not found. Run 'skynet init' first.");
    process.exit(1);
  }

  const devDir = vars.SKYNET_DEV_DIR || `${projectDir}/.dev`;
  const mainBranch = vars.SKYNET_MAIN_BRANCH || "main";
  const isDryRun = options.dryRun === true;

  console.log(`\n  Skynet Git Recovery${isDryRun ? " (DRY RUN)" : ""}\n`);

  // Check for divergence
  {
    const result = spawnSync("git", ["fetch", "origin", mainBranch], {
      cwd: projectDir,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30000,
    });
    if (result.status !== 0) {
      const msg = result.stderr ? result.stderr.toString().trim() : "unknown error";
      console.error(`  Failed to fetch origin: ${msg}`);
      process.exit(1);
    }
  }

  let divergedCount: number;
  {
    const result = spawnSync("git", ["rev-list", "--count", `origin/${mainBranch}..${mainBranch}`], {
      cwd: projectDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status !== 0) {
      console.error("  Failed to detect divergence. Is this a git repository?");
      process.exit(1);
    }
    divergedCount = parseInt((result.stdout as string).trim(), 10) || 0;
  }

  if (divergedCount === 0) {
    console.log("  No divergence detected. Local main is up-to-date with origin.\n");
    process.exit(0);
  }

  console.log(`  Divergence: ${divergedCount} local commit(s) ahead of origin/${mainBranch}\n`);

  // Show diverged commits
  const logResult = spawnSync(
    "git", ["log", "--oneline", `origin/${mainBranch}..${mainBranch}`],
    { cwd: projectDir, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }
  );
  const logOutput = (logResult.stdout as string).trim();

  console.log("  Diverged commits:");
  for (const line of logOutput.split("\n")) {
    console.log(`    ${line}`);
  }

  // Extract task titles from commit messages
  const taskTitles: string[] = [];
  for (const line of logOutput.split("\n")) {
    // Pattern: "chore: update pipeline status after <title>"
    const match = line.match(/chore: update pipeline status after (?:fixing )?(.+)$/);
    if (match) {
      taskTitles.push(match[1].trim());
    }
  }

  if (taskTitles.length > 0) {
    console.log("\n  Affected tasks:");
    for (const title of taskTitles) {
      console.log(`    - ${title}`);
    }
  }

  if (isDryRun) {
    console.log("\n  Dry run — no changes made.");
    console.log("  Run without --dry-run to reset local main to origin.\n");
    process.exit(0);
  }

  if (!options.force) {
    console.error("\n  Use --force to proceed with git reset. This is destructive!");
    console.error("  (Hint: run with --dry-run first to preview changes)\n");
    process.exit(1);
  }

  // Reset to origin
  console.log(`\n  Resetting local ${mainBranch} to origin/${mainBranch}...`);
  {
    const result = spawnSync("git", ["reset", "--hard", `origin/${mainBranch}`], {
      cwd: projectDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status !== 0) {
      const msg = result.stderr ? result.stderr.toString().trim() : "unknown error";
      console.error(`  Git reset failed: ${msg}`);
      process.exit(1);
    }
    console.log("  Git reset: OK");
  }

  // Reset incorrectly-completed tasks in SQLite to 'failed'
  if (isSqliteReady(devDir) && taskTitles.length > 0) {
    console.log("\n  Resetting affected tasks to 'failed' in SQLite...");
    // Safety: sqlEscape handles quotes, backslashes, newlines, and NUL bytes.
    // The escaped value is always embedded in SQL single-quoted string literals.
    // See sqliteQuery.ts JSDoc for the full security model.
    for (const title of taskTitles) {
      try {
        const escaped = sqlEscape(title);
        const rows = sqliteRows(devDir,
          `SELECT id, status FROM tasks WHERE title='${escaped}' AND status IN ('completed','fixed');`
        );
        for (const row of rows) {
          const id = row[0];
          sqliteQuery(devDir,
            `UPDATE tasks SET status='failed', error='push divergence recovery', updated_at=datetime('now') WHERE id=${Number(id)};`
          );
          console.log(`    Reset task ${id}: '${title}' -> failed`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`    Could not reset '${title}': ${msg}`);
      }
    }
  }

  console.log("\n  Recovery complete. Pipeline state has been reset.\n");
}
