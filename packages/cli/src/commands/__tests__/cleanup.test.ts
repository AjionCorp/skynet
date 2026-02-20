import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", () => ({
  readFileSync: vi.fn(() => ""),
  existsSync: vi.fn(() => false),
}));

vi.mock("child_process", () => ({
  execSync: vi.fn(() => ""),
}));

import { readFileSync, existsSync } from "fs";
import { execSync } from "child_process";
import { cleanupCommand } from "../cleanup";

const mockReadFileSync = vi.mocked(readFileSync);
const mockExistsSync = vi.mocked(existsSync);
const mockExecSync = vi.mocked(execSync);

const CONFIG_CONTENT = [
  'export SKYNET_PROJECT_NAME="test-project"',
  'export SKYNET_PROJECT_DIR="/tmp/test-project"',
  'export SKYNET_DEV_DIR="/tmp/test-project/.dev"',
  'export SKYNET_MAIN_BRANCH="main"',
  'export SKYNET_BRANCH_PREFIX="dev/"',
].join("\n");

const SAMPLE_BACKLOG = `# Backlog

- [ ] [FEAT] Pending task — description
- [>] [FEAT] Claimed active task — in progress
`;

const SAMPLE_FAILED = `| Date | Task | Branch | Error | Worker | Status |
|------|------|--------|-------|--------|--------|
| 2026-02-20 | Failed task | dev/failed-task | typecheck | 1 | pending |
| 2026-02-19 | Old failure | dev/old-failure | lint | 2 | fixed |
`;

describe("cleanupCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return true;
      return false;
    });

    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return CONFIG_CONTENT as never;
      if (path.endsWith("backlog.md")) return SAMPLE_BACKLOG as never;
      if (path.endsWith("failed-tasks.md")) return SAMPLE_FAILED as never;
      return "" as never;
    });

    mockExecSync.mockImplementation((cmd) => {
      const cmdStr = String(cmd);
      // git branch --list 'dev/*' — returns all dev branches
      if (cmdStr.includes("branch --list"))
        return "  dev/merged-feature\n  dev/orphaned-branch\n  dev/claimed-active-task\n  dev/failed-task\n" as never;
      // git branch --merged main --list 'dev/*' — only merged-feature is merged
      if (cmdStr.includes("--merged"))
        return "  dev/merged-feature\n" as never;
      // git worktree list — no worktrees
      if (cmdStr.includes("worktree list"))
        return "" as never;
      // git branch -D — deletion
      if (cmdStr.includes("branch -D"))
        return "" as never;
      // git worktree prune
      if (cmdStr.includes("worktree prune"))
        return "" as never;
      return "" as never;
    });
  });

  it("lists deletable branches in dry run mode (default)", async () => {
    await cleanupCommand({ dir: "/tmp/test-project" });

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");

    // Should show dry run label
    expect(logCalls).toContain("dry run");

    // Merged branch should be listed for deletion
    expect(logCalls).toContain("dev/merged-feature");
    expect(logCalls).toContain("merged into main");

    // Orphaned branch should be listed for deletion
    expect(logCalls).toContain("dev/orphaned-branch");

    // Should NOT delete anything (no git branch -D calls)
    const deleteCalls = mockExecSync.mock.calls.filter((c) =>
      String(c[0]).includes("branch -D"),
    );
    expect(deleteCalls).toHaveLength(0);
  });

  it("preserves active branches (claimed in backlog)", async () => {
    await cleanupCommand({ dir: "/tmp/test-project" });

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");

    // Claimed branch should be preserved
    expect(logCalls).toContain("dev/claimed-active-task");
    expect(logCalls).toContain("claimed [>] in backlog");
  });

  it("preserves branches with pending failed-tasks entries", async () => {
    await cleanupCommand({ dir: "/tmp/test-project" });

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");

    // Failed-pending branch should be preserved
    expect(logCalls).toContain("dev/failed-task");
    expect(logCalls).toContain("pending in failed-tasks");
  });

  it("deletes branches with --force", async () => {
    await cleanupCommand({ dir: "/tmp/test-project", force: true });

    // Should have called git branch -D for merged and orphaned branches
    const deleteCalls = mockExecSync.mock.calls.filter((c) =>
      String(c[0]).includes("branch -D"),
    );
    expect(deleteCalls.length).toBeGreaterThanOrEqual(2);

    // Verify specific branches deleted
    const deletedBranches = deleteCalls.map((c) => String(c[0]));
    expect(deletedBranches.some((c) => c.includes("dev/merged-feature"))).toBe(true);
    expect(deletedBranches.some((c) => c.includes("dev/orphaned-branch"))).toBe(true);

    // Should NOT delete active branches
    expect(deletedBranches.some((c) => c.includes("dev/claimed-active-task"))).toBe(false);
    expect(deletedBranches.some((c) => c.includes("dev/failed-task"))).toBe(false);
  });

  it("prunes worktrees after force deletion", async () => {
    await cleanupCommand({ dir: "/tmp/test-project", force: true });

    const pruneCalls = mockExecSync.mock.calls.filter((c) =>
      String(c[0]).includes("worktree prune"),
    );
    expect(pruneCalls).toHaveLength(1);
  });

  it("reports deletion count in force mode", async () => {
    await cleanupCommand({ dir: "/tmp/test-project", force: true });

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");
    expect(logCalls).toContain("Deleted 2 branch(es)");
    expect(logCalls).toContain("pruned worktrees");
  });

  it("reports 'would be deleted' count in dry run", async () => {
    await cleanupCommand({ dir: "/tmp/test-project" });

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");
    expect(logCalls).toContain("2 branch(es) would be deleted");
    expect(logCalls).toContain("Run with --force to apply");
  });

  it("handles no dev branches gracefully", async () => {
    mockExecSync.mockImplementation((cmd) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("branch --list")) return "" as never;
      return "" as never;
    });

    await cleanupCommand({ dir: "/tmp/test-project" });

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");
    expect(logCalls).toContain("No dev/* branches found");
  });

  it("throws when config file is missing", async () => {
    mockExistsSync.mockReturnValue(false);

    await expect(
      cleanupCommand({ dir: "/tmp/test-project" }),
    ).rejects.toThrow("skynet.config.sh not found");
  });

  it("preserves branches with active worktrees", async () => {
    mockExecSync.mockImplementation((cmd) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("branch --list"))
        return "  dev/worktree-branch\n" as never;
      if (cmdStr.includes("--merged"))
        return "" as never;
      if (cmdStr.includes("worktree list"))
        return "worktree /tmp/skynet-test-project-worktree-w1\nHEAD abc123\nbranch refs/heads/dev/worktree-branch\n" as never;
      return "" as never;
    });

    await cleanupCommand({ dir: "/tmp/test-project" });

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");
    expect(logCalls).toContain("dev/worktree-branch");
    expect(logCalls).toContain("has worktree");
  });
});
