import { readFileSync, writeFileSync, renameSync, existsSync } from "fs";
import { resolve, join } from "path";
import { spawnSync } from "child_process";
import { createInterface } from "readline";
import { loadConfig } from "../utils/loadConfig";
import { acquireBacklogLock, releaseBacklogLock } from "../utils/backlogLock";
import { isSqliteReady, sqliteQuery, sqlEscape } from "../utils/sqliteQuery";

interface ResetTaskOptions {
  dir?: string;
  force?: boolean;
}

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`  ${question} `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

function atomicWrite(filePath: string, content: string) {
  const tmpPath = filePath + ".tmp";
  writeFileSync(tmpPath, content, "utf-8");
  renameSync(tmpPath, filePath);
}

function isValidBranchName(branch: string): boolean {
  return /^[a-zA-Z0-9._\/-]+$/.test(branch);
}

function branchExists(branch: string, projectDir: string): boolean {
  if (!isValidBranchName(branch)) return false;
  const result = spawnSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
    cwd: projectDir,
    stdio: "ignore",
  });
  return result.status === 0;
}

function deleteBranch(branch: string, projectDir: string) {
  if (!isValidBranchName(branch)) return;
  spawnSync("git", ["branch", "-D", branch], {
    cwd: projectDir,
    stdio: "inherit",
  });
}

export async function resetTaskCommand(titleSubstring: string, options: ResetTaskOptions) {
  if (!titleSubstring || titleSubstring.trim().length === 0) {
    console.error("Error: Task title substring is required.");
    process.exit(1);
  }

  const projectDir = resolve(options.dir || process.cwd());
  const vars = loadConfig(projectDir);
  if (!vars) {
    console.error("skynet.config.sh not found. Run 'skynet init' first.");
    process.exit(1);
  }
  const devDir = vars.SKYNET_DEV_DIR || `${projectDir}/.dev`;
  const failedPath = join(devDir, "failed-tasks.md");
  const backlogPath = join(devDir, "backlog.md");

  if (!existsSync(failedPath)) {
    console.error(`Error: failed-tasks.md not found at ${failedPath}. Run 'skynet init' first.`);
    process.exit(1);
  }

  if (!existsSync(backlogPath)) {
    console.error(`Error: backlog.md not found at ${backlogPath}. Run 'skynet init' first.`);
    process.exit(1);
  }

  // Derive lock path from config (same as shell: ${SKYNET_LOCK_PREFIX}-backlog.lock)
  const projectName = vars.SKYNET_PROJECT_NAME || "unknown";
  const lockPrefix = vars.SKYNET_LOCK_PREFIX || `/tmp/skynet-${projectName}`;
  const lockPath = `${lockPrefix}-backlog.lock`;

  if (!acquireBacklogLock(lockPath)) {
    console.error("Error: Could not acquire backlog lock. Another process may be modifying backlog.md.");
    process.exit(1);
  }

  let branchName = "";
  try {
    // --- Step 1: Find matching entry in failed-tasks.md ---
    const failedContent = readFileSync(failedPath, "utf-8");
    const failedLines = failedContent.split("\n");
    const searchTerm = titleSubstring.trim().toLowerCase();

    const matchingIndices: number[] = [];
    for (let i = 0; i < failedLines.length; i++) {
      const line = failedLines[i];
      // Skip header, separator, and empty lines
      if (!line.startsWith("|") || line.includes("| Date |") || line.includes("------")) continue;
      const cols = line.split("|").map((c) => c.trim());
      // cols[0]="" (before first |), cols[1]=date, cols[2]=title, cols[3]=branch, ...
      const title = cols[2] || "";
      if (title.toLowerCase().includes(searchTerm)) {
        matchingIndices.push(i);
      }
    }

    if (matchingIndices.length === 0) {
      console.error(`\n  Error: No matching task found in failed-tasks.md for "${titleSubstring}".\n`);
      process.exit(1);
    }

    if (matchingIndices.length > 1) {
      console.error(`\n  Error: Multiple tasks match "${titleSubstring}":\n`);
      for (const idx of matchingIndices) {
        const cols = failedLines[idx].split("|").map((c) => c.trim());
        console.error(`    - ${cols[2]}`);
      }
      console.error(`\n  Please use a more specific substring.\n`);
      process.exit(1);
    }

    const matchIdx = matchingIndices[0];
    const matchLine = failedLines[matchIdx];
    const cols = matchLine.split("|").map((c) => c.trim());
    // cols: ["", date, title, branch, error, attempts, status, ""]
    const taskTitle = cols[2];
    branchName = cols[3];
    const taskError = cols[4];
    const taskDate = cols[1];

    console.log(`\n  Found failed task:\n`);
    console.log(`    Title:    ${taskTitle}`);
    console.log(`    Branch:   ${branchName}`);
    console.log(`    Error:    ${taskError}`);
    console.log(`    Attempts: ${cols[5]}`);
    console.log(`    Status:   ${cols[6]}`);

    // --- Step 2: Reset status to pending and attempts to 0 ---
    failedLines[matchIdx] = `| ${taskDate} | ${taskTitle} | ${branchName} | ${taskError} | 0 | pending |`;
    atomicWrite(failedPath, failedLines.join("\n"));
    console.log(`\n  Reset failed-tasks.md entry: attempts → 0, status → pending`);

    // Also reset in SQLite if available
    try {
      if (isSqliteReady(devDir)) {
        const safeTitle = sqlEscape(taskTitle);
        sqliteQuery(devDir,
          `UPDATE tasks SET status='pending', attempts=0, error=NULL, fixer_id=NULL, updated_at='${new Date().toISOString()}' ` +
          `WHERE title='${safeTitle}' AND status IN ('failed','fixing-1','fixing-2','fixing-3','blocked');`
        );
      }
    } catch (err) {
      if (process.env.SKYNET_DEBUG) {
        console.error(`  [debug] SQLite reset failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // --- Step 3: Find and uncheck corresponding backlog entry ---
    const backlogContent = readFileSync(backlogPath, "utf-8");
    const backlogLines = backlogContent.split("\n");
    let backlogUpdated = false;

    for (let i = 0; i < backlogLines.length; i++) {
      if (backlogLines[i].startsWith("- [x] ") && backlogLines[i].toLowerCase().includes(searchTerm)) {
        backlogLines[i] = backlogLines[i].replace(/^- \[x\] /, "- [ ] ");
        backlogUpdated = true;
        console.log(`  Reset backlog.md entry: [x] → [ ]`);
        break;
      }
    }

    if (backlogUpdated) {
      atomicWrite(backlogPath, backlogLines.join("\n"));
    } else {
      console.log(`  Warning: No matching [x] entry found in backlog.md (skipped)`);
    }
  } finally {
    releaseBacklogLock(lockPath);
  }

  // --- Step 4: Optionally delete the failed branch ---
  if (branchName && branchExists(branchName, projectDir)) {
    if (options.force) {
      console.log(`  Deleting branch: ${branchName}`);
      deleteBranch(branchName, projectDir);
      console.log(`  Branch deleted.`);
    } else {
      const answer = await prompt(`Delete branch "${branchName}"? (y/N)`);
      if (answer === "y" || answer === "yes") {
        deleteBranch(branchName, projectDir);
        console.log(`  Branch deleted.`);
      } else {
        console.log(`  Branch kept.`);
      }
    }
  }

  console.log(`\n  Task reset complete.\n`);
}
