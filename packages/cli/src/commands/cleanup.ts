import { resolve, join } from "path";
import { execSync } from "child_process";
import { loadConfig } from "../utils/loadConfig";
import { readFile } from "../utils/readFile";

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
    const output = execSync("git branch --list 'dev/*'", {
      cwd: projectDir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return output
      .split("\n")
      .map((l) => l.replace(/^[*+\s]+/, "").trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function getMergedBranches(projectDir: string, mainBranch: string): Set<string> {
  if (!isValidBranchName(mainBranch)) return new Set();
  try {
    const output = execSync(`git branch --merged ${mainBranch} --list 'dev/*'`, {
      cwd: projectDir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return new Set(
      output
        .split("\n")
        .map((l) => l.replace(/^[*+\s]+/, "").trim())
        .filter(Boolean)
    );
  } catch {
    return new Set();
  }
}

function getWorktreeBranches(projectDir: string): Set<string> {
  const branches = new Set<string>();
  try {
    const output = execSync("git worktree list --porcelain", {
      cwd: projectDir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    for (const line of output.split("\n")) {
      const match = line.match(/^branch refs\/heads\/(.+)/);
      if (match) {
        branches.add(match[1]);
      }
    }
  } catch {
    // ignore
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
  const claimedSlugs = getClaimedSlugs(devDir);
  const failedPending = getFailedBranches(devDir);

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
        execSync(`git branch -D ${b.name}`, {
          cwd: projectDir,
          stdio: ["pipe", "pipe", "pipe"],
        });
        deletedCount++;
        console.log(`  Deleted: ${b.name}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  Failed to delete ${b.name}: ${msg}`);
      }
    }

    // Prune worktrees
    try {
      execSync("git worktree prune", {
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
