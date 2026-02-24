import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("fs", () => ({
  existsSync: vi.fn(() => true),
}));

vi.mock("child_process", () => ({
  spawn: vi.fn(() => ({ on: vi.fn(), unref: vi.fn() })),
  exec: vi.fn(),
}));

vi.mock("os", () => ({
  platform: vi.fn(() => "darwin"),
}));

import { existsSync } from "fs";
import { spawn, exec } from "child_process";
import { platform } from "os";
import { dashboardCommand } from "../dashboard";

const mockExistsSync = vi.mocked(existsSync);
const mockSpawn = vi.mocked(spawn);
const _mockExec = vi.mocked(exec);
const mockPlatform = vi.mocked(platform);

describe("dashboardCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    mockExistsSync.mockReturnValue(true);
    mockSpawn.mockReturnValue({ on: vi.fn(), unref: vi.fn() } as never);
    mockPlatform.mockReturnValue("darwin");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("launches pnpm dev command with correct --port argument", async () => {
    await dashboardCommand({ port: "4000" });

    expect(mockSpawn).toHaveBeenCalledWith(
      "pnpm",
      ["--filter", "admin", "dev", "--", "--port", "4000"],
      expect.objectContaining({ stdio: "inherit" }),
    );
  });

  it("default port is 3100", async () => {
    await dashboardCommand({});

    expect(mockSpawn).toHaveBeenCalledWith(
      "pnpm",
      ["--filter", "admin", "dev", "--", "--port", "3100"],
      expect.objectContaining({ stdio: "inherit" }),
    );
  });

  it("--port flag overrides default", async () => {
    await dashboardCommand({ port: "5000" });

    expect(mockSpawn).toHaveBeenCalledWith(
      "pnpm",
      ["--filter", "admin", "dev", "--", "--port", "5000"],
      expect.objectContaining({ stdio: "inherit" }),
    );
  });

  it("opens browser via 'open' on macOS", async () => {
    mockPlatform.mockReturnValue("darwin");

    await dashboardCommand({});
    vi.advanceTimersByTime(3000);

    // The openBrowser function uses spawn, not exec
    const openCalls = mockSpawn.mock.calls.filter((c) =>
      c[0] === "open"
    );
    expect(openCalls).toHaveLength(1);
    expect(openCalls[0][1]).toEqual([expect.stringContaining("http://localhost:")]);
  });

  // TEST-P3-1: Port validation tests
  it("rejects port 0 with process.exit(1)", async () => {
    await expect(dashboardCommand({ port: "0" })).rejects.toThrow("process.exit");
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Port must be a number between 1 and 65535"),
    );
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("rejects port above 65535 with process.exit(1)", async () => {
    await expect(dashboardCommand({ port: "99999" })).rejects.toThrow("process.exit");
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Port must be a number between 1 and 65535"),
    );
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("rejects non-numeric port with process.exit(1)", async () => {
    await expect(dashboardCommand({ port: "abc" })).rejects.toThrow("process.exit");
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Port must be a number between 1 and 65535"),
    );
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("opens browser via 'xdg-open' on Linux", async () => {
    mockPlatform.mockReturnValue("linux");

    await dashboardCommand({});
    vi.advanceTimersByTime(3000);

    // The openBrowser function uses spawn, not exec
    const openCalls = mockSpawn.mock.calls.filter((c) =>
      c[0] === "xdg-open"
    );
    expect(openCalls).toHaveLength(1);
    expect(openCalls[0][1]).toEqual([expect.stringContaining("http://localhost:")]);
  });
});
