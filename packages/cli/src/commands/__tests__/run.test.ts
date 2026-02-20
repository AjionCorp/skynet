import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";

vi.mock("fs", () => ({
  readFileSync: vi.fn(() => ""),
  existsSync: vi.fn(() => false),
}));

vi.mock("child_process", () => ({
  spawn: vi.fn(),
}));

import { readFileSync, existsSync } from "fs";
import { spawn } from "child_process";
import { runCommand } from "../run";

const mockReadFileSync = vi.mocked(readFileSync);
const mockExistsSync = vi.mocked(existsSync);
const mockSpawn = vi.mocked(spawn);

const CONFIG_CONTENT = [
  'export SKYNET_PROJECT_NAME="test-project"',
  'export SKYNET_PROJECT_DIR="/tmp/test-project"',
  'export SKYNET_DEV_DIR="/tmp/test-project/.dev"',
  'export SKYNET_TYPECHECK_CMD="pnpm typecheck"',
].join("\n");

function createMockChild(exitCode = 0): EventEmitter {
  const child = new EventEmitter();
  // Emit close on next tick so the promise resolves
  process.nextTick(() => child.emit("close", exitCode));
  return child;
}

describe("runCommand", () => {
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
      if (path.endsWith("dev-worker.sh")) return true;
      return false;
    });

    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return CONFIG_CONTENT as never;
      return "" as never;
    });
  });

  it("spawns dev-worker.sh with SKYNET_ONE_SHOT=true", async () => {
    mockSpawn.mockReturnValue(createMockChild(0) as never);

    await runCommand("Implement feature X", { dir: "/tmp/test-project" });

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = mockSpawn.mock.calls[0];
    expect(cmd).toBe("bash");
    expect(args).toEqual(
      expect.arrayContaining([expect.stringContaining("dev-worker.sh")]),
    );
    expect(opts).toEqual(
      expect.objectContaining({
        stdio: "inherit",
        cwd: "/tmp/test-project",
      }),
    );
    // Check env vars
    const env = (opts as { env: Record<string, string> }).env;
    expect(env.SKYNET_ONE_SHOT).toBe("true");
    expect(env.SKYNET_ONE_SHOT_TASK).toBe("Implement feature X");
    expect(env.SKYNET_MAX_TASKS_PER_RUN).toBe("1");
  });

  it("uses worker ID 99 by default", async () => {
    mockSpawn.mockReturnValue(createMockChild(0) as never);

    await runCommand("Some task", { dir: "/tmp/test-project" });

    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toContain("99");
  });

  it("uses custom worker ID from options", async () => {
    mockSpawn.mockReturnValue(createMockChild(0) as never);

    await runCommand("Some task", { dir: "/tmp/test-project", worker: "5" });

    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toContain("5");
  });

  it("resolves 'typecheck' gate to SKYNET_TYPECHECK_CMD", async () => {
    mockSpawn.mockReturnValue(createMockChild(0) as never);

    await runCommand("Some task", { dir: "/tmp/test-project", gate: "typecheck" });

    const opts = mockSpawn.mock.calls[0][2] as { env: Record<string, string> };
    expect(opts.env.SKYNET_GATE_1).toBe("pnpm typecheck");
  });

  it("passes through raw gate command", async () => {
    mockSpawn.mockReturnValue(createMockChild(0) as never);

    await runCommand("Some task", { dir: "/tmp/test-project", gate: "npm test" });

    const opts = mockSpawn.mock.calls[0][2] as { env: Record<string, string> };
    expect(opts.env.SKYNET_GATE_1).toBe("npm test");
  });

  it("sets SKYNET_AGENT_PLUGIN when --agent is provided", async () => {
    mockSpawn.mockReturnValue(createMockChild(0) as never);

    await runCommand("Some task", { dir: "/tmp/test-project", agent: "claude" });

    const opts = mockSpawn.mock.calls[0][2] as { env: Record<string, string> };
    expect(opts.env.SKYNET_AGENT_PLUGIN).toBe("claude");
  });

  it("exits with child's exit code on failure", async () => {
    mockSpawn.mockReturnValue(createMockChild(42) as never);

    await expect(
      runCommand("Failing task", { dir: "/tmp/test-project" }),
    ).rejects.toThrow("process.exit");

    expect(process.exit).toHaveBeenCalledWith(42);
  });

  it("rejects empty task description", async () => {
    await expect(
      runCommand("", { dir: "/tmp/test-project" }),
    ).rejects.toThrow("process.exit");

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Task description is required"),
    );
  });

  it("errors when dev-worker.sh is missing", async () => {
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return true;
      // dev-worker.sh does NOT exist
      return false;
    });

    await expect(
      runCommand("Some task", { dir: "/tmp/test-project" }),
    ).rejects.toThrow("process.exit");

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("dev-worker.sh not found"),
    );
  });

  it("errors when SKYNET_PROJECT_NAME is not set", async () => {
    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh"))
        return 'export SKYNET_DEV_DIR="/tmp/test/.dev"' as never;
      return "" as never;
    });

    await expect(
      runCommand("Some task", { dir: "/tmp/test-project" }),
    ).rejects.toThrow("process.exit");

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("SKYNET_PROJECT_NAME not set"),
    );
  });
});
