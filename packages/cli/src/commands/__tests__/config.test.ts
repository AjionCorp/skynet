import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", () => ({
  readFileSync: vi.fn(() => ""),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  existsSync: vi.fn(() => false),
}));

vi.mock("child_process", () => ({
  execSync: vi.fn(),
}));

import { readFileSync, writeFileSync, renameSync, existsSync } from "fs";
import { execSync } from "child_process";
import { configListCommand, configGetCommand, configSetCommand } from "../config";

const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockRenameSync = vi.mocked(renameSync);
const mockExistsSync = vi.mocked(existsSync);
const mockExecSync = vi.mocked(execSync);

const CONFIG_CONTENT = `export SKYNET_PROJECT_NAME="test-project"
export SKYNET_PROJECT_DIR="/tmp/test"
export SKYNET_DEV_DIR="/tmp/test/.dev"
export SKYNET_MAX_WORKERS="2"
export SKYNET_STALE_MINUTES="45"
export SKYNET_MAIN_BRANCH="main"
`;

describe("configListCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(CONFIG_CONTENT as never);
  });

  it("parses SKYNET_* variables from config file", async () => {
    await configListCommand({ dir: "/tmp/test" });

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");

    // Should display the parsed variables
    expect(logCalls).toContain("SKYNET_PROJECT_NAME");
    expect(logCalls).toContain("test-project");
    expect(logCalls).toContain("SKYNET_MAX_WORKERS");
    expect(logCalls).toContain("SKYNET_STALE_MINUTES");
  });

  it("displays description for known variables", async () => {
    await configListCommand({ dir: "/tmp/test" });

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");

    // Known vars should have descriptions
    expect(logCalls).toContain("Project name identifier");
    expect(logCalls).toContain("Max parallel workers");
  });
});

describe("configSetCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(CONFIG_CONTENT as never);
  });

  it("validates SKYNET_MAX_WORKERS as positive integer", async () => {
    // Valid value should succeed
    await configSetCommand("SKYNET_MAX_WORKERS", "4", { dir: "/tmp/test" });
    expect(mockWriteFileSync).toHaveBeenCalled();

    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(CONFIG_CONTENT as never);

    // Invalid: not a number
    await expect(
      configSetCommand("SKYNET_MAX_WORKERS", "abc", { dir: "/tmp/test" }),
    ).rejects.toThrow("process.exit");
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("positive integer"),
    );
  });

  it("rejects SKYNET_MAX_WORKERS of zero", async () => {
    await expect(
      configSetCommand("SKYNET_MAX_WORKERS", "0", { dir: "/tmp/test" }),
    ).rejects.toThrow("process.exit");
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("positive integer"),
    );
  });

  it("rejects SKYNET_MAX_WORKERS of negative value", async () => {
    await expect(
      configSetCommand("SKYNET_MAX_WORKERS", "-3", { dir: "/tmp/test" }),
    ).rejects.toThrow("process.exit");
  });

  it("rejects SKYNET_STALE_MINUTES < 5", async () => {
    await expect(
      configSetCommand("SKYNET_STALE_MINUTES", "3", { dir: "/tmp/test" }),
    ).rejects.toThrow("process.exit");
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining(">= 5"),
    );
  });

  it("accepts SKYNET_STALE_MINUTES of exactly 5", async () => {
    await configSetCommand("SKYNET_STALE_MINUTES", "5", { dir: "/tmp/test" });
    expect(mockWriteFileSync).toHaveBeenCalled();
  });

  it("validates SKYNET_MAIN_BRANCH via git check-ref-format", async () => {
    // Valid branch name
    mockExecSync.mockReturnValue(Buffer.from("") as never);
    await configSetCommand("SKYNET_MAIN_BRANCH", "develop", { dir: "/tmp/test" });
    expect(mockWriteFileSync).toHaveBeenCalled();

    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(CONFIG_CONTENT as never);

    // Invalid branch name: git check-ref-format throws
    mockExecSync.mockImplementation(() => {
      throw new Error("invalid ref");
    });
    await expect(
      configSetCommand("SKYNET_MAIN_BRANCH", "bad..name", { dir: "/tmp/test" }),
    ).rejects.toThrow("process.exit");
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("not a valid git branch name"),
    );
  });

  it("performs atomic write via .tmp then rename", async () => {
    await configSetCommand("SKYNET_MAX_WORKERS", "4", { dir: "/tmp/test" });

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining("skynet.config.sh.tmp"),
      expect.any(String),
      "utf-8",
    );
    expect(mockRenameSync).toHaveBeenCalledWith(
      expect.stringContaining("skynet.config.sh.tmp"),
      expect.stringContaining("skynet.config.sh"),
    );
  });

  it("updates the value in the config content", async () => {
    await configSetCommand("SKYNET_MAX_WORKERS", "8", { dir: "/tmp/test" });

    const writtenContent = mockWriteFileSync.mock.calls[0][1] as string;
    expect(writtenContent).toContain('export SKYNET_MAX_WORKERS="8"');
    expect(writtenContent).not.toContain('export SKYNET_MAX_WORKERS="2"');
  });
});

describe("configGetCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(CONFIG_CONTENT as never);
  });

  it("prints the value of an existing key", async () => {
    await configGetCommand("SKYNET_PROJECT_NAME", { dir: "/tmp/test" });

    expect(console.log).toHaveBeenCalledWith("test-project");
  });

  it("exits with error for missing key", async () => {
    await expect(
      configGetCommand("SKYNET_NONEXISTENT", { dir: "/tmp/test" }),
    ).rejects.toThrow("process.exit");

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("not found"),
    );
  });
});
