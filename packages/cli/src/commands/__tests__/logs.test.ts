import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", () => ({
  readFileSync: vi.fn(() => ""),
  existsSync: vi.fn(() => false),
  statSync: vi.fn(() => ({ size: 0, mtime: new Date() })),
  readdirSync: vi.fn(() => []),
  watch: vi.fn(() => ({ close: vi.fn() })),
  openSync: vi.fn(() => 3),
  readSync: vi.fn(() => 0),
  closeSync: vi.fn(),
}));

import {
  readFileSync,
  existsSync,
  statSync,
  readdirSync,
  watch,
} from "fs";
import { logsCommand } from "../logs";

const mockReadFileSync = vi.mocked(readFileSync);
const mockExistsSync = vi.mocked(existsSync);
const mockStatSync = vi.mocked(statSync);
const mockReaddirSync = vi.mocked(readdirSync);
const mockWatch = vi.mocked(watch);

const CONFIG_CONTENT = [
  'export SKYNET_PROJECT_NAME="test-project"',
  'export SKYNET_DEV_DIR="/tmp/test-project/.dev"',
  'export SKYNET_LOCK_PREFIX="/tmp/skynet-test-project"',
].join("\n");

describe("logsCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return true;
      return false;
    });

    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return CONFIG_CONTENT as never;
      return "" as never;
    });
  });

  it("lists available log files when no type is given", async () => {
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return true;
      if (path.endsWith("/scripts")) return true;
      return false;
    });

    mockReaddirSync.mockReturnValue([
      "dev-worker-1.log",
      "watchdog.log",
    ] as never);

    mockStatSync.mockReturnValue({
      size: 2048,
      mtime: new Date("2026-01-15"),
      isDirectory: () => false,
    } as never);

    await logsCommand(undefined, { dir: "/tmp/test-project" });

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");
    expect(logCalls).toContain("Available log files");
    expect(logCalls).toContain("dev-worker-1.log");
    expect(logCalls).toContain("watchdog.log");
  });

  it("reads last N lines with --tail flag", async () => {
    const logContent = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");

    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return true;
      if (path.endsWith("dev-worker-1.log")) return true;
      return false;
    });

    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return CONFIG_CONTENT as never;
      if (path.endsWith("dev-worker-1.log")) return logContent as never;
      return "" as never;
    });

    await logsCommand("worker", { dir: "/tmp/test-project", tail: "5" });

    const written = (process.stdout.write as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => String(c[0]))
      .join("");
    expect(written).toContain("line 96");
    expect(written).toContain("line 100");
    expect(written).not.toContain("line 95");
  });

  it("sets up fs.watch in --follow mode", async () => {
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return true;
      if (path.endsWith("dev-worker-1.log")) return true;
      return false;
    });

    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return CONFIG_CONTENT as never;
      return "some log content\n" as never;
    });

    mockStatSync.mockReturnValue({ size: 100 } as never);

    await logsCommand("worker", { dir: "/tmp/test-project", follow: true });

    expect(mockWatch).toHaveBeenCalledWith(
      expect.stringContaining("dev-worker-1.log"),
      expect.any(Function),
    );
  });

  it("exits with error when scripts directory is missing", async () => {
    // existsSync returns false for scripts dir
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return true;
      return false;
    });

    await expect(
      logsCommand(undefined, { dir: "/tmp/test-project" }),
    ).rejects.toThrow("process.exit");

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Scripts directory not found"),
    );
  });

  it("selects correct worker log with --id flag", async () => {
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return true;
      if (path.endsWith("dev-worker-3.log")) return true;
      return false;
    });

    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return CONFIG_CONTENT as never;
      if (path.endsWith("dev-worker-3.log")) return "worker 3 output\n" as never;
      return "" as never;
    });

    await logsCommand("worker", { dir: "/tmp/test-project", id: "3" });

    const written = (process.stdout.write as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => String(c[0]))
      .join("");
    expect(written).toContain("worker 3 output");
  });

  it("exits with error for unknown log type", async () => {
    await expect(
      logsCommand("bogus", { dir: "/tmp/test-project" }),
    ).rejects.toThrow("process.exit");

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Unknown log type"),
    );
  });

  it("exits with error for non-numeric worker ID", async () => {
    await expect(
      logsCommand("worker", { dir: "/tmp/test-project", id: "abc" }),
    ).rejects.toThrow("process.exit");

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Invalid worker ID"),
    );
  });

  it("exits with error for invalid --tail value", async () => {
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return true;
      if (path.endsWith("watchdog.log")) return true;
      return false;
    });

    await expect(
      logsCommand("watchdog", { dir: "/tmp/test-project", tail: "notanumber" }),
    ).rejects.toThrow("process.exit");

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Invalid --tail value"),
    );
  });

  it("defaults worker ID to 1 when --id is not provided", async () => {
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return true;
      if (path.endsWith("dev-worker-1.log")) return true;
      return false;
    });

    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return CONFIG_CONTENT as never;
      if (path.endsWith("dev-worker-1.log")) return "default worker\n" as never;
      return "" as never;
    });

    await logsCommand("worker", { dir: "/tmp/test-project" });

    const written = (process.stdout.write as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => String(c[0]))
      .join("");
    expect(written).toContain("default worker");
  });
});
