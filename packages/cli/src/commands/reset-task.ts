import { resolve } from "path";
import { spawnSync } from "child_process";
import { createInterface } from "readline";
import { loadConfig } from "../utils/loadConfig";
import { isSqliteReady, sqliteQuery, sqliteRows, sqlEscape } from "../utils/sqliteQuery";

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

  if (!isSqliteReady(devDir)) {
    console.error("Error: SQLite database not found. Run 'skynet init' first.");
    process.exit(1);
  }

  const searchTerm = titleSubstring.trim();
  const safeTerm = sqlEscape(searchTerm);

  // Find matching tasks in SQLite
  const rows = sqliteRows(devDir,
    `SELECT id, title, branch, error, attempts, status FROM tasks ` +
    `WHERE title LIKE '%${safeTerm}%' AND status IN ('failed','fixing-1','fixing-2','fixing-3','blocked');`
  );

  if (rows.length === 0) {
    console.error(`\n  Error: No matching failed/blocked task found for "${titleSubstring}".\n`);
    process.exit(1);
  }

  if (rows.length > 1) {
    console.error(`\n  Error: Multiple tasks match "${titleSubstring}":\n`);
    for (const row of rows) {
      console.error(`    - ${row[1]}`);
    }
    console.error(`\n  Please use a more specific substring.\n`);
    process.exit(1);
  }

  const [taskId, taskTitle, branchName, taskError, attempts, status] = rows[0];

  console.log(`\n  Found failed task:\n`);
  console.log(`    Title:    ${taskTitle}`);
  console.log(`    Branch:   ${branchName}`);
  console.log(`    Error:    ${taskError}`);
  console.log(`    Attempts: ${attempts}`);
  console.log(`    Status:   ${status}`);

  // Reset the task in SQLite
  if (!taskId || isNaN(Number(taskId))) {
    console.error("Invalid task ID");
    process.exit(1);
  }
  const now = sqlEscape(new Date().toISOString());
  sqliteQuery(devDir,
    `UPDATE tasks SET status='pending', attempts=0, error=NULL, fixer_id=NULL, updated_at='${now}' ` +
    `WHERE id=${Number(taskId)};`
  );
  console.log(`\n  Reset task: attempts → 0, status → pending`);

  // Optionally delete the failed branch
  if (branchName && isValidBranchName(String(branchName)) && branchExists(String(branchName), projectDir)) {
    if (options.force) {
      console.log(`  Deleting branch: ${branchName}`);
      deleteBranch(String(branchName), projectDir);
      console.log(`  Branch deleted.`);
    } else {
      const answer = await prompt(`Delete branch "${branchName}"? (y/N)`);
      if (answer === "y" || answer === "yes") {
        deleteBranch(String(branchName), projectDir);
        console.log(`  Branch deleted.`);
      } else {
        console.log(`  Branch kept.`);
      }
    }
  }

  console.log(`\n  Task reset complete.\n`);
}
