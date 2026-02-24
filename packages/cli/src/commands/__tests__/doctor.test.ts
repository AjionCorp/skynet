import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", () => ({
  readFileSync: vi.fn(() => ""),
  existsSync: vi.fn(() => false),
  readdirSync: vi.fn(() => []),
  unlinkSync: vi.fn(),
  writeFileSync: vi.fn(),
  rmSync: vi.fn(),
  statSync: vi.fn(() => ({ mtime: new Date(), mtimeMs: Date.now(), isDirectory: () => false })),
}));

vi.mock("child_process", () => ({
  execSync: vi.fn(() => Buffer.from("")),
  spawnSync: vi.fn(() => ({ stdout: "", stderr: "", status: 0 })),
}));

import { readFileSync, existsSync, readdirSync, writeFileSync } from "fs";
import { execSync, spawnSync } from "child_process";
import { doctorCommand } from "../doctor";

const mockReadFileSync = vi.mocked(readFileSync);
const mockExistsSync = vi.mocked(existsSync);
const mockExecSync = vi.mocked(execSync);
const mockSpawnSync = vi.mocked(spawnSync);
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

/**
 * Build a default spawnSync mock that handles both getToolVersion calls
 * (spawnSync("sh", ["-c", "cmd"])) and git operations (spawnSync("git", [...])).
 */
function makeSpawnSyncMock(overrides?: Record<string, string>) {
  return (cmd: unknown, args?: unknown) => {
    const cmdStr = String(cmd);
    const argsArr = Array.isArray(args) ? args.map(String) : [];

    // getToolVersion: spawnSync("sh", ["-c", "<version-cmd>"])
    if (cmdStr === "sh" && argsArr[0] === "-c") {
      const shellCmd = argsArr[1] || "";
      // Check for explicit failure overrides first (value === "FAIL")
      if (overrides?.[shellCmd] === "FAIL") {
        return { stdout: "", stderr: "not found", status: 1 };
      }
      // Check for explicit output overrides
      if (overrides?.[shellCmd]) {
        return { stdout: overrides[shellCmd], stderr: "", status: 0 };
      }
      if (shellCmd.includes("git --version")) return { stdout: "git version 2.39.0", stderr: "", status: 0 };
      if (shellCmd.includes("node --version")) return { stdout: "v20.0.0", stderr: "", status: 0 };
      if (shellCmd.includes("pnpm --version")) return { stdout: "8.0.0", stderr: "", status: 0 };
      if (shellCmd.includes("shellcheck --version")) return { stdout: "0.9.0", stderr: "", status: 0 };
      if (shellCmd.includes("claude --version")) return { stdout: "1.0.0", stderr: "", status: 0 };
      if (shellCmd.includes("codex --version")) return { stdout: "0.5.0", stderr: "", status: 0 };
      if (shellCmd.includes("command -v")) {
        // Default: tool found
        const toolName = shellCmd.split("command -v ")[1]?.trim();
        return { stdout: `/usr/bin/${toolName}`, stderr: "", status: 0 };
      }
      return { stdout: "", stderr: "", status: 0 };
    }

    // Git operations: spawnSync("git", [...])
    if (cmdStr === "git") {
      if (argsArr.includes("rev-parse")) return { stdout: "main\n", stderr: "", status: 0 };
      if (argsArr.includes("--porcelain")) return { stdout: "", stderr: "", status: 0 };
      if (argsArr.includes("worktree")) return { stdout: "", stderr: "", status: 0 };
      return { stdout: "", stderr: "", status: 0 };
    }

    return { stdout: "", stderr: "", status: 0 };
  };
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
    // Default spawnSync mock for getToolVersion and git operations
    mockSpawnSync.mockImplementation(makeSpawnSyncMock() as never);
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

    await expect(doctorCommand({ dir: "/tmp/test-project" })).rejects.toThrow("process.exit");

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");
    expect(logCalls).toContain("[FAIL]");
    expect(logCalls).toContain("NOT FOUND");
  });

  it("outputs FAIL when .dev/ directory is missing", async () => {
    // existsSync returns false for everything — no .dev/ dir, no config
    mockExistsSync.mockReturnValue(false);

    await expect(doctorCommand({ dir: "/tmp/test-project" })).rejects.toThrow("process.exit");

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");
    expect(logCalls).toContain("[FAIL]");
    // Should mention config not found
    expect(logCalls).toContain("NOT FOUND");
  });

  it("detects stale lock files and reports WARN for workers", async () => {
    const configContent = makeConfigContent();

    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return true;
      if (path.endsWith(".dev/scripts")) return true;
      if (path.match(/\.(sh)$/)) return true;
      if (path.endsWith("backlog.md")) return true;
      if (path.endsWith("completed.md")) return true;
      if (path.endsWith("failed-tasks.md")) return true;
      if (path.endsWith("mission.md")) return true;
      // Stale lock file exists for dev-worker-1
      if (path.endsWith("dev-worker-1.lock")) return true;
      return false;
    });

    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return configContent as never;
      // Lock file with a dead PID
      if (path.endsWith("dev-worker-1.lock")) return "999999" as never;
      return "" as never;
    });

    mockReaddirSync.mockReturnValue([] as never);

    await doctorCommand({ dir: "/tmp/test-project" });

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");
    // Worker section should show STALE lock
    expect(logCalls).toContain("STALE");
    expect(logCalls).toContain("[WARN]");
  });

  it("reports SQLite integrity check results", async () => {
    const configContent = makeConfigContent();

    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return true;
      if (path.endsWith(".dev/scripts")) return true;
      if (path.match(/\.(sh)$/)) return true;
      if (path.endsWith("backlog.md")) return true;
      if (path.endsWith("completed.md")) return true;
      if (path.endsWith("failed-tasks.md")) return true;
      if (path.endsWith("mission.md")) return true;
      if (path.endsWith("skynet.db")) return true;
      return false;
    });

    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return configContent as never;
      return "" as never;
    });

    mockReaddirSync.mockReturnValue([] as never);

    await doctorCommand({ dir: "/tmp/test-project" });

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");
    // Should show SQLite Database section
    expect(logCalls).toContain("SQLite Database");
  });

  it("validates gate commands and warns when not found", async () => {
    const configContent = makeConfigContent({
      SKYNET_GATE_1: "nonexistent-tool --check",
    });

    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return true;
      if (path.endsWith(".dev/scripts")) return true;
      if (path.match(/\.(sh)$/)) return true;
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

    // Override spawnSync to make `command -v nonexistent-tool` fail
    mockSpawnSync.mockImplementation(makeSpawnSyncMock({
      "command -v nonexistent-tool": "FAIL",
    }) as never);

    mockReaddirSync.mockReturnValue([] as never);

    await doctorCommand({ dir: "/tmp/test-project" });

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");
    // Config Validation section should warn about the missing gate command
    expect(logCalls).toContain("NOT FOUND");
    expect(logCalls).toContain("SKYNET_GATE_1");
  });

  it("--fix replaces [>] with [ ] for orphaned claimed tasks in backlog", async () => {
    const configContent = makeConfigContent();
    const backlogContent = [
      "# Backlog",
      "",
      "- [>] [INFRA] Orphaned claimed task — no matching current-task file",
      "- [ ] [DATA] Normal pending task — description",
      "- [>] [TEST] Another orphaned claim — also no file",
    ].join("\n");

    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return true;
      if (path.endsWith(".dev/scripts")) return true;
      if (path.match(/\.(sh)$/)) return true;
      if (path.endsWith("backlog.md")) return true;
      if (path.endsWith("completed.md")) return true;
      if (path.endsWith("failed-tasks.md")) return true;
      if (path.endsWith("mission.md")) return true;
      return false;
    });

    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return configContent as never;
      if (path.endsWith("backlog.md")) return backlogContent as never;
      return "" as never;
    });

    // No current-task files in devDir => claimed tasks are orphaned
    mockReaddirSync.mockReturnValue([] as never);

    const mockWriteFileSync = vi.mocked(writeFileSync);

    await doctorCommand({ dir: "/tmp/test-project", fix: true });

    // Should have written the fixed backlog
    const writeCall = mockWriteFileSync.mock.calls.find(
      (c) => (c[0] as string).endsWith("backlog.md"),
    );
    expect(writeCall).toBeDefined();
    const fixedContent = writeCall![1] as string;
    // [>] should be replaced with [ ] for both orphaned tasks
    expect(fixedContent).toContain("- [ ] [INFRA] Orphaned claimed task");
    expect(fixedContent).toContain("- [ ] [TEST] Another orphaned claim");
    // Normal pending task should remain unchanged
    expect(fixedContent).toContain("- [ ] [DATA] Normal pending task");

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");
    expect(logCalls).toContain("Fixed:");
    expect(logCalls).toContain("orphaned claimed task");
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

    mockReaddirSync.mockReturnValue([] as never);

    await doctorCommand({ dir: "/tmp/test-project" });

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");
    expect(logCalls).toContain("[WARN]");
    expect(logCalls).toContain("stale");
  });
});
