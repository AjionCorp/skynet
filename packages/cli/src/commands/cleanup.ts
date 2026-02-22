import { resolve, join } from "path";
import { spawnSync } from "child_process";
import { loadConfig } from "../utils/loadConfig";
import { readFile } from "../utils/readFile";
import { isSqliteReady, sqliteRows } from "../utils/sqliteQuery";

interface CleanupOptions {
  dir?: string;
  force?: boolean;
}

function isValidBranchName(branch: string): boolean {
  return /^[a-zA-Z0-9._\/-]+$/.test(branch);
}

function slugify(title: string): string {
  return title
    .replace(/^\[.*?\]\s*/, "")
    .toLowerCase()
    .replace(/ /g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 40);
}

function getDevBranches(projectDir: string): string[] {
  try {
    const result = spawnSync("git", ["branch", "--list", "dev/*"], {
      cwd: projectDir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return (result.stdout || "")
      .split("\n")
      .map((l) => l.replace(/^[*+\s]+/, "").trim())
      .filter(Boolean);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Warning: failed to list dev branches — ${msg}`);
    return [];
  }
}

function getMergedBranches(projectDir: string, mainBranch: string): Set<string> {
  if (!isValidBranchName(mainBranch)) return new Set();
  try {
    const result = spawnSync("git", ["branch", "--merged", mainBranch, "--list", "dev/*"], {
      cwd: projectDir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return new Set(
      (result.stdout || "")
        .split("\n")
        .map((l) => l.replace(/^[*+\s]+/, "").trim())
        .filter(Boolean)
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Warning: failed to list merged branches — ${msg}`);
    return new Set();
  }
}

function getWorktreeBranches(projectDir: string): Set<string> {
  const branches = new Set<string>();
  try {
    const result = spawnSync("git", ["worktree", "list", "--porcelain"], {
      cwd: projectDir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    for (const line of (result.stdout || "").split("\n")) {
      const match = line.match(/^branch refs\/heads\/(.+)/);
      if (match) {
        branches.add(match[1]);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Warning: failed to list worktree branches — ${msg}`);
  }
  return branches;
}

function getClaimedSlugs(devDir: string): Set<string> {
  const slugs = new Set<string>();
  const backlog = readFile(join(devDir, "backlog.md"));
  for (const line of backlog.split("\n")) {
    if (line.startsWith("- [>] ")) {
      const title = line.replace(/^- \[>\] /, "").split(" — ")[0].trim();
      slugs.add(slugify(title));
    }
  }
  return slugs;
}

function getFailedBranches(devDir: string): Set<string> {
  const branches = new Set<string>();
  const failed = readFile(join(devDir, "failed-tasks.md"));
  for (const line of failed.split("\n")) {
    if (!line.startsWith("|") || line.includes("| Date |") || line.includes("------")) continue;
    const cols = line.split("|").map((c) => c.trim());
    const branch = cols[3] || "";
    const status = cols[6] || "";
    if (branch && status === "pending") {
      branches.add(branch);
    }
  }
  return branches;
}

type BranchStatus = "merged" | "orphaned" | "active";

interface BranchInfo {
  name: string;
  status: BranchStatus;
  reason: string;
}

export async function cleanupCommand(options: CleanupOptions) {
  const projectDir = resolve(options.dir || process.cwd());
  const vars = loadConfig(projectDir);
  if (!vars) {
    console.error("skynet.config.sh not found. Run 'skynet init' first.");
    process.exit(1);
  }

  const devDir = vars.SKYNET_DEV_DIR || `${projectDir}/.dev`;
  const mainBranch = vars.SKYNET_MAIN_BRANCH || "main";
  const branchPrefix = vars.SKYNET_BRANCH_PREFIX || "dev/";
  const dryRun = !options.force;

  console.log(`\n  Skynet Branch Cleanup${dryRun ? " (dry run)" : ""}\n`);

  // Gather data
  const allBranches = getDevBranches(projectDir);
  if (allBranches.length === 0) {
    console.log("  No dev/* branches found.\n");
    return;
  }

  const merged = getMergedBranches(projectDir, mainBranch);
  const worktrees = getWorktreeBranches(projectDir);
  let claimedSlugs: Set<string>;
  let failedPending: Set<string>;

  // Try SQLite first for claimed slugs and failed branches
  if (isSqliteReady(devDir)) {
    try {
      // Claimed tasks from SQLite
      const claimedRows = sqliteRows(devDir, "SELECT title FROM tasks WHERE status='claimed';");
      claimedSlugs = new Set(claimedRows.map((r) => slugify(r[0] || "")));
      // Failed pending branches from SQLite
      const failedRows = sqliteRows(devDir, "SELECT branch FROM tasks WHERE status IN ('failed','fixing-1','fixing-2','fixing-3') AND branch IS NOT NULL AND branch != '';");
      failedPending = new Set(failedRows.map((r) => r[0]).filter(Boolean));
    } catch (err) {
      if (process.env.SKYNET_DEBUG) console.error(`  [debug] SQLite cleanup query: ${err instanceof Error ? err.message : String(err)}`);
      claimedSlugs = getClaimedSlugs(devDir);
      failedPending = getFailedBranches(devDir);
    }
  } else {
    claimedSlugs = getClaimedSlugs(devDir);
    failedPending = getFailedBranches(devDir);
  }

  // Classify each branch
  const branches: BranchInfo[] = [];

  for (const branch of allBranches) {
    if (merged.has(branch)) {
      branches.push({ name: branch, status: "merged", reason: `merged into ${mainBranch}` });
      continue;
    }

    if (worktrees.has(branch)) {
      branches.push({ name: branch, status: "active", reason: "has worktree" });
      continue;
    }

    const slug = branch.replace(new RegExp(`^${branchPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), "");
    if (claimedSlugs.has(slug)) {
      branches.push({ name: branch, status: "active", reason: "claimed [>] in backlog" });
      continue;
    }

    if (failedPending.has(branch)) {
      branches.push({ name: branch, status: "active", reason: "pending in failed-tasks" });
      continue;
    }

    branches.push({ name: branch, status: "orphaned", reason: "no matching backlog/failed entry" });
  }

  // Display
  const deletable = branches.filter((b) => b.status === "merged" || b.status === "orphaned");
  const active = branches.filter((b) => b.status === "active");

  if (deletable.length > 0) {
    console.log("  Branches to delete:");
    for (const b of deletable) {
      console.log(`    ${b.name}  (${b.reason})`);
    }
  }

  if (active.length > 0) {
    console.log("\n  Branches preserved (active):");
    for (const b of active) {
      console.log(`    ${b.name}  (${b.reason})`);
    }
  }

  // Act
  let deletedCount = 0;
  let pruned = false;

  if (!dryRun && deletable.length > 0) {
    console.log("");
    for (const b of deletable) {
      if (!isValidBranchName(b.name)) continue;
      try {
        const result = spawnSync("git", ["branch", "-D", b.name], {
          cwd: projectDir,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });
        if (result.status === 0) {
          deletedCount++;
          console.log(`  Deleted: ${b.name}`);
        } else {
          console.error(`  Failed to delete ${b.name}: ${(result.stderr || "").trim()}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  Failed to delete ${b.name}: ${msg}`);
      }
    }

    // Prune worktrees
    try {
      spawnSync("git", ["worktree", "prune"], {
        cwd: projectDir,
        stdio: ["pipe", "pipe", "pipe"],
      });
      pruned = true;
    } catch {
      // ignore
    }
  }

  // Summary
  console.log("");
  if (dryRun) {
    console.log(`  Dry run: ${deletable.length} branch(es) would be deleted, ${active.length} branch(es) preserved (active)`);
    console.log("  Run with --force to apply changes.\n");
  } else {
    const pruneMsg = pruned ? ", pruned worktrees" : "";
    console.log(`  Deleted ${deletedCount} branch(es)${pruneMsg}, ${active.length} branch(es) preserved (active)\n`);
  }
}
