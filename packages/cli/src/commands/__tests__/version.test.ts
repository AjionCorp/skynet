import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => ""),
}));

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(() => ""),
}));

vi.mock("node:url", () => ({
  fileURLToPath: vi.fn(() => "/fake/dist/commands/version.js"),
}));

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { versionCommand } from "../version";

const mockExecSync = vi.mocked(execSync);
const mockReadFileSync = vi.mocked(readFileSync);

describe("versionCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});

    // Default: local version 0.1.0
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ version: "0.1.0" }) as never,
    );
  });

  it("outputs version string from package.json", async () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ version: "1.2.3" }) as never,
    );
    mockExecSync.mockReturnValue("1.2.3\n" as never);

    await versionCommand();

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");
    expect(logCalls).toContain("skynet-cli v1.2.3");
  });

  it("suggests upgrade when outdated version detected", async () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ version: "0.1.0" }) as never,
    );
    mockExecSync.mockReturnValue("0.2.0\n" as never);

    await versionCommand();

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");
    expect(logCalls).toContain("skynet-cli v0.1.0");
    expect(logCalls).toContain("Update available");
    expect(logCalls).toContain("v0.1.0");
    expect(logCalls).toContain("v0.2.0");
    expect(logCalls).toContain("npm install -g @ajioncorp/skynet-cli@latest");
  });

  it("does not show upgrade notice when on latest version", async () => {
    mockExecSync.mockReturnValue("0.1.0\n" as never);

    await versionCommand();

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");
    expect(logCalls).toContain("skynet-cli v0.1.0");
    expect(logCalls).not.toContain("Update available");
  });

  it("handles npm registry check failure gracefully", async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("network error");
    });

    await versionCommand();

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");
    // Should still print local version
    expect(logCalls).toContain("skynet-cli v0.1.0");
    // Should not show upgrade notice
    expect(logCalls).not.toContain("Update available");
  });

  it("calls npm view with correct package name", async () => {
    mockExecSync.mockReturnValue("0.1.0\n" as never);

    await versionCommand();

    expect(mockExecSync).toHaveBeenCalledWith(
      "npm view @ajioncorp/skynet-cli version",
      expect.objectContaining({
        timeout: 5000,
        encoding: "utf-8",
      }),
    );
  });
});
