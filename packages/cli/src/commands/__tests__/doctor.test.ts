import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", () => ({
  readFileSync: vi.fn(() => ""),
  existsSync: vi.fn(() => false),
  readdirSync: vi.fn(() => []),
  unlinkSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock("child_process", () => ({
  execSync: vi.fn(() => Buffer.from("")),
}));

import { readFileSync, existsSync, readdirSync } from "fs";
import { execSync } from "child_process";
import { doctorCommand } from "../doctor";

const mockReadFileSync = vi.mocked(readFileSync);
const mockExistsSync = vi.mocked(existsSync);
const mockExecSync = vi.mocked(execSync);
const mockReaddirSync = vi.mocked(readdirSync);

/** Build a valid config file content with all required vars. */
function makeConfigContent(overrides: Record<string, string> = {}): string {
  const defaults: Record<string, string> = {
    SKYNET_PROJECT_NAME: "test-project",
    SKYNET_PROJECT_DIR: "/tmp/test-project",
    SKYNET_DEV_DIR: "/tmp/test-project/.dev",
    SKYNET_LOCK_PREFIX: "/tmp/skynet-test-project",
    SKYNET_MAIN_BRANCH: "main",
    SKYNET_MAX_WORKERS: "2",
    SKYNET_STALE_MINUTES: "45",
    SKYNET_BRANCH_PREFIX: "dev/",
  };
  const vars = { ...defaults, ...overrides };
  return Object.entries(vars)
    .map(([k, v]) => `export ${k}="${v}"`)
    .join("\n");
}

describe("doctorCommand", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("outputs PASS for healthy config with all checks passing", async () => {
    const configContent = makeConfigContent();

    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return true;
      if (path.endsWith(".dev/scripts")) return true;
      // Expected scripts
      if (path.match(/\.(sh)$/)) return true;
      // State files
      if (path.endsWith("backlog.md")) return true;
      if (path.endsWith("completed.md")) return true;
      if (path.endsWith("failed-tasks.md")) return true;
      if (path.endsWith("mission.md")) return true;
      return false;
    });

    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return configContent as never;
      return "" as never;
    });

    // All tools found, git works
    mockExecSync.mockImplementation((cmd) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("git --version")) return Buffer.from("git version 2.39.0") as never;
      if (cmdStr.includes("node --version")) return Buffer.from("v20.0.0") as never;
      if (cmdStr.includes("pnpm --version")) return Buffer.from("8.0.0") as never;
      if (cmdStr.includes("shellcheck --version")) return Buffer.from("0.9.0") as never;
      if (cmdStr.includes("claude --version")) return Buffer.from("1.0.0") as never;
      if (cmdStr.includes("codex --version")) return Buffer.from("0.5.0") as never;
      if (cmdStr.includes("rev-parse --abbrev-ref")) return Buffer.from("main") as never;
      if (cmdStr.includes("git status --porcelain")) return Buffer.from("") as never;
      if (cmdStr.includes("git worktree list")) return Buffer.from("") as never;
      return Buffer.from("") as never;
    });

    await doctorCommand({ dir: "/tmp/test-project" });

    // Should NOT call process.exit (no failures)
    expect(exitSpy).not.toHaveBeenCalled();

    // Summary should include PASS entries
    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");
    expect(logCalls).toContain("[PASS]");
    expect(logCalls).toContain("All checks passed");
  });

  it("outputs FAIL when .dev/ directory is missing (no config)", async () => {
    // Everything returns false for existsSync — no config file
    mockExistsSync.mockReturnValue(false);

    // Tools work fine
    mockExecSync.mockImplementation((cmd) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("git --version")) return Buffer.from("git version 2.39.0") as never;
      if (cmdStr.includes("node --version")) return Buffer.from("v20.0.0") as never;
      if (cmdStr.includes("pnpm --version")) return Buffer.from("8.0.0") as never;
      if (cmdStr.includes("shellcheck --version")) return Buffer.from("0.9.0") as never;
      if (cmdStr.includes("claude --version")) return Buffer.from("1.0.0") as never;
      if (cmdStr.includes("codex --version")) return Buffer.from("0.5.0") as never;
      if (cmdStr.includes("rev-parse --abbrev-ref")) return Buffer.from("main") as never;
      if (cmdStr.includes("git status --porcelain")) return Buffer.from("") as never;
      if (cmdStr.includes("git worktree list")) return Buffer.from("") as never;
      return Buffer.from("") as never;
    });

    await expect(doctorCommand({ dir: "/tmp/test-project" })).rejects.toThrow("process.exit");

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");
    expect(logCalls).toContain("[FAIL]");
    expect(logCalls).toContain("NOT FOUND");
  });

  it("outputs WARN for stale heartbeat", async () => {
    const configContent = makeConfigContent({ SKYNET_STALE_MINUTES: "45" });

    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return true;
      if (path.endsWith(".dev/scripts")) return true;
      if (path.match(/\.(sh)$/)) return true;
      if (path.endsWith("backlog.md")) return true;
      if (path.endsWith("completed.md")) return true;
      if (path.endsWith("failed-tasks.md")) return true;
      if (path.endsWith("mission.md")) return true;
      // Heartbeat file exists for worker 1
      if (path.endsWith("worker-1.heartbeat")) return true;
      return false;
    });

    // Stale heartbeat: epoch from 2 hours ago
    const staleEpoch = Math.floor((Date.now() - 2 * 60 * 60 * 1000) / 1000);

    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return configContent as never;
      if (path.endsWith("worker-1.heartbeat")) return String(staleEpoch) as never;
      return "" as never;
    });

    mockExecSync.mockImplementation((cmd) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("git --version")) return Buffer.from("git version 2.39.0") as never;
      if (cmdStr.includes("node --version")) return Buffer.from("v20.0.0") as never;
      if (cmdStr.includes("pnpm --version")) return Buffer.from("8.0.0") as never;
      if (cmdStr.includes("shellcheck --version")) return Buffer.from("0.9.0") as never;
      if (cmdStr.includes("claude --version")) return Buffer.from("1.0.0") as never;
      if (cmdStr.includes("codex --version")) return Buffer.from("0.5.0") as never;
      if (cmdStr.includes("rev-parse --abbrev-ref")) return Buffer.from("main") as never;
      if (cmdStr.includes("git status --porcelain")) return Buffer.from("") as never;
      if (cmdStr.includes("git worktree list")) return Buffer.from("") as never;
      return Buffer.from("") as never;
    });

    mockReaddirSync.mockReturnValue([] as never);

    await doctorCommand({ dir: "/tmp/test-project" });

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");
    expect(logCalls).toContain("[WARN]");
    expect(logCalls).toContain("stale");
  });
});
