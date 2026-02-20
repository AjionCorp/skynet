import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => ""),
}));

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(() => ""),
}));

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { upgradeCommand } from "../upgrade";

const mockExecSync = vi.mocked(execSync);
const mockReadFileSync = vi.mocked(readFileSync);

describe("upgradeCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    // Default: local version 0.1.0
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ version: "0.1.0" }) as never,
    );
  });

  it("prints 'Already on latest' when versions match", async () => {
    mockExecSync.mockReturnValue("0.1.0\n" as never);

    await upgradeCommand({});

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");
    expect(logCalls).toContain("Already on latest");
    expect(process.exitCode).toBeUndefined();
  });

  it("shows update available with --check flag without installing", async () => {
    mockExecSync.mockReturnValue("0.2.0\n" as never);

    await upgradeCommand({ check: true });

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");
    expect(logCalls).toContain("Update available");
    expect(logCalls).toContain("v0.1.0");
    expect(logCalls).toContain("v0.2.0");
    expect(logCalls).toContain("Run 'skynet upgrade' to install");

    // Should NOT have called npm install
    const installCalls = mockExecSync.mock.calls.filter((c) =>
      String(c[0]).includes("npm install"),
    );
    expect(installCalls).toHaveLength(0);
  });

  it("runs npm install -g when update is available and --check is not set", async () => {
    // First call: npm view returns newer version
    // Second call: npm install succeeds
    mockExecSync.mockImplementation((cmd) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("npm view")) return "0.2.0\n" as never;
      if (cmdStr.includes("npm install")) return "" as never;
      return "" as never;
    });

    await upgradeCommand({});

    const installCalls = mockExecSync.mock.calls.filter((c) =>
      String(c[0]).includes("npm install -g @ajioncorp/skynet-cli@latest"),
    );
    expect(installCalls).toHaveLength(1);

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");
    expect(logCalls).toContain("Upgraded to v0.2.0");
  });

  it("sets exitCode=1 when npm registry check fails", async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("network error");
    });

    await upgradeCommand({});

    expect(process.exitCode).toBe(1);
    const errorCalls = (console.error as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");
    expect(errorCalls).toContain("Failed to check npm registry");
  });

  it("sets exitCode=1 when install fails", async () => {
    let callCount = 0;
    mockExecSync.mockImplementation((cmd) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("npm view")) return "0.2.0\n" as never;
      if (cmdStr.includes("npm install")) throw new Error("permission denied");
      return "" as never;
    });

    await upgradeCommand({});

    expect(process.exitCode).toBe(1);
    const errorCalls = (console.error as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");
    expect(errorCalls).toContain("Upgrade failed");
  });

  it("displays current version from package.json", async () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ version: "1.5.3" }) as never,
    );
    mockExecSync.mockReturnValue("1.5.3\n" as never);

    await upgradeCommand({});

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");
    expect(logCalls).toContain("v1.5.3");
  });
});
