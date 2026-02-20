import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", () => ({
  readFileSync: vi.fn(() => ""),
  existsSync: vi.fn(() => false),
  statfsSync: vi.fn(() => ({ bfree: 0, bsize: 0 })),
}));

vi.mock("child_process", () => ({
  execSync: vi.fn(() => Buffer.from("")),
}));

import { readFileSync, existsSync, statfsSync } from "fs";
import { execSync } from "child_process";
import { validateCommand } from "../validate";

const mockReadFileSync = vi.mocked(readFileSync);
const mockExistsSync = vi.mocked(existsSync);
const mockExecSync = vi.mocked(execSync);
const mockStatfsSync = vi.mocked(statfsSync);

/** Build a config file with optional SKYNET_GATE_N entries. */
function makeConfigContent(overrides: Record<string, string> = {}): string {
  const defaults: Record<string, string> = {
    SKYNET_PROJECT_NAME: "test-project",
    SKYNET_PROJECT_DIR: "/tmp/test-project",
    SKYNET_DEV_DIR: "/tmp/test-project/.dev",
  };
  const vars = { ...defaults, ...overrides };
  return Object.entries(vars)
    .map(([k, v]) => `export ${k}="${v}"`)
    .join("\n");
}

/** Helper: set up mocks for a healthy baseline (all checks pass). */
function setupHealthy(configContent: string) {
  mockExistsSync.mockImplementation((p) => {
    const path = String(p);
    if (path.endsWith("skynet.config.sh")) return true;
    if (path.endsWith("mission.md")) return true;
    return false;
  });

  mockReadFileSync.mockImplementation((p) => {
    const path = String(p);
    if (path.endsWith("skynet.config.sh")) return configContent as never;
    if (path.endsWith("mission.md")) return "# Mission\nBuild something great\n" as never;
    return "" as never;
  });

  mockExecSync.mockImplementation(() => Buffer.from("") as never);

  mockStatfsSync.mockReturnValue({ bfree: 500000, bsize: 4096 } as never);
}

function getLogOutput(): string {
  return (console.log as ReturnType<typeof vi.fn>).mock.calls.flat().join("\n");
}

describe("validateCommand", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("runs gate command and reports PASS for valid config with SKYNET_GATE_1", async () => {
    const config = makeConfigContent({ SKYNET_GATE_1: "pnpm typecheck" });
    setupHealthy(config);

    await validateCommand({ dir: "/tmp/test-project" });

    expect(mockExecSync).toHaveBeenCalledWith("pnpm typecheck", expect.objectContaining({
      cwd: "/tmp/test-project",
    }));
    const logs = getLogOutput();
    expect(logs).toContain("Gate 1: pnpm typecheck");
    expect(logs).toContain("Result: PASS");
    expect(logs).toContain("[PASS] Quality Gates");
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("reports FAIL when gate command fails", async () => {
    const config = makeConfigContent({ SKYNET_GATE_1: "pnpm typecheck" });
    setupHealthy(config);

    mockExecSync.mockImplementation((cmd) => {
      const cmdStr = String(cmd);
      if (cmdStr === "pnpm typecheck") throw new Error("typecheck failed");
      // git ls-remote should still succeed
      return Buffer.from("") as never;
    });

    await expect(validateCommand({ dir: "/tmp/test-project" })).rejects.toThrow("process.exit");

    const logs = getLogOutput();
    expect(logs).toContain("Result: FAIL");
    expect(logs).toContain("[FAIL] Quality Gates");
  });

  it("reports WARN when no SKYNET_GATE_N variables are defined", async () => {
    const config = makeConfigContent();
    setupHealthy(config);

    await validateCommand({ dir: "/tmp/test-project" });

    const logs = getLogOutput();
    expect(logs).toContain("No SKYNET_GATE_N variables defined");
    expect(logs).toContain("[WARN] Quality Gates");
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("reports Git Remote PASS when git ls-remote succeeds", async () => {
    const config = makeConfigContent();
    setupHealthy(config);

    await validateCommand({ dir: "/tmp/test-project" });

    expect(mockExecSync).toHaveBeenCalledWith("git ls-remote origin HEAD", expect.objectContaining({
      cwd: "/tmp/test-project",
    }));
    const logs = getLogOutput();
    expect(logs).toContain("[PASS] Git Remote");
  });

  it("reports Git Remote FAIL when git ls-remote fails", async () => {
    const config = makeConfigContent();
    setupHealthy(config);

    mockExecSync.mockImplementation((cmd) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("git ls-remote")) throw new Error("connection refused");
      return Buffer.from("") as never;
    });

    await expect(validateCommand({ dir: "/tmp/test-project" })).rejects.toThrow("process.exit");

    const logs = getLogOutput();
    expect(logs).toContain("Cannot reach remote");
    expect(logs).toContain("[FAIL] Git Remote");
  });

  it("reports WARN when disk space is less than 1 GB", async () => {
    const config = makeConfigContent();
    setupHealthy(config);

    // 500 MB free: bfree * bsize = 500 * 1024 * 1024
    mockStatfsSync.mockReturnValue({
      bfree: 500 * 256,
      bsize: 4096,
    } as never);

    await validateCommand({ dir: "/tmp/test-project" });

    const logs = getLogOutput();
    expect(logs).toContain("[WARN] Disk Space");
    expect(logs).toContain("low disk space");
  });

  it("reports FAIL when .dev/mission.md is missing", async () => {
    const config = makeConfigContent();
    setupHealthy(config);

    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return true;
      if (path.endsWith("mission.md")) return false;
      return false;
    });

    await expect(validateCommand({ dir: "/tmp/test-project" })).rejects.toThrow("process.exit");

    const logs = getLogOutput();
    expect(logs).toContain("mission.md not found");
    expect(logs).toContain("[FAIL] Mission File");
  });

  it("reports FAIL when mission.md is empty", async () => {
    const config = makeConfigContent();
    setupHealthy(config);

    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return config as never;
      if (path.endsWith("mission.md")) return "" as never;
      return "" as never;
    });

    await expect(validateCommand({ dir: "/tmp/test-project" })).rejects.toThrow("process.exit");

    const logs = getLogOutput();
    expect(logs).toContain("mission.md exists but is empty");
    expect(logs).toContain("[FAIL] Mission File");
  });

  it("exits with code 1 when any check is FAIL", async () => {
    // Config not found → Quality Gates FAIL → exit(1)
    mockExistsSync.mockReturnValue(false);
    mockExecSync.mockImplementation(() => Buffer.from("") as never);
    mockStatfsSync.mockReturnValue({ bfree: 500000, bsize: 4096 } as never);

    await expect(validateCommand({ dir: "/tmp/test-project" })).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
