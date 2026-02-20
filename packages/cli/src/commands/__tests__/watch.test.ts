import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("fs", () => ({
  readFileSync: vi.fn(() => ""),
  existsSync: vi.fn(() => false),
  statSync: vi.fn(() => ({ isDirectory: () => false })),
  readdirSync: vi.fn(() => []),
}));

vi.mock("child_process", () => ({
  execSync: vi.fn(() => Buffer.from("")),
}));

import { readFileSync, existsSync } from "fs";
import { watchCommand } from "../watch";

const mockReadFileSync = vi.mocked(readFileSync);
const mockExistsSync = vi.mocked(existsSync);

const CONFIG_CONTENT = [
  'export SKYNET_PROJECT_NAME="test-project"',
  'export SKYNET_PROJECT_DIR="/tmp/test-project"',
  'export SKYNET_DEV_DIR="/tmp/test-project/.dev"',
  'export SKYNET_LOCK_PREFIX="/tmp/skynet-test-project"',
  'export SKYNET_MAX_WORKERS="2"',
].join("\n");

const SAMPLE_BACKLOG = `# Backlog

- [ ] [FEAT] Pending task one — description
- [ ] [FIX] Pending task two
- [>] [FEAT] Claimed task — in progress
- [x] [FEAT] Done task
`;

const SAMPLE_COMPLETED = `| Date | Task | Branch |
|------|------|--------|
| 2026-02-20 | First task | dev/first-task |
| 2026-02-19 | Second task | dev/second-task |
`;

const SAMPLE_FAILED = `| Date | Task | Branch | Error | Worker | Status |
|------|------|--------|-------|--------|--------|
| 2026-02-20 | Bad task | dev/bad | typecheck | 1 | pending |
| 2026-02-19 | Old task | dev/old | lint | 2 | fixed |
`;

describe("watchCommand", () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return true;
      return false;
    });

    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return CONFIG_CONTENT as never;
      if (path.endsWith("backlog.md")) return SAMPLE_BACKLOG as never;
      if (path.endsWith("completed.md")) return SAMPLE_COMPLETED as never;
      if (path.endsWith("failed-tasks.md")) return SAMPLE_FAILED as never;
      return "" as never;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads state files and renders dashboard output", async () => {
    // watchCommand sets up interval — we just need the initial render
    const promise = watchCommand({ dir: "/tmp/test-project" });

    // The initial render should have written to stdout
    const output = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");

    // Should contain project name
    expect(output).toContain("test-project");
    // Should contain task counts from backlog
    expect(output).toContain("2 pending");
    expect(output).toContain("1 claimed");
    // Should contain completed count
    expect(output).toContain("2 completed");
    // Should contain failed count
    expect(output).toContain("1 failed");
    // Should contain worker IDs
    expect(output).toContain("Skynet Watch");

    // Clean up: we can't easily stop the interval without SIGINT,
    // but fake timers prevent real execution
  });

  it("refreshes dashboard on interval tick", async () => {
    const promise = watchCommand({ dir: "/tmp/test-project" });

    const initialCallCount = stdoutSpy.mock.calls.length;

    // Advance 3 seconds to trigger the interval
    vi.advanceTimersByTime(3000);

    // Should have rendered again
    expect(stdoutSpy.mock.calls.length).toBeGreaterThan(initialCallCount);
  });

  it("throws when config file is missing", async () => {
    mockExistsSync.mockReturnValue(false);

    await expect(watchCommand({ dir: "/tmp/test-project" })).rejects.toThrow(
      "skynet.config.sh not found",
    );
  });

  it("shows health score in output", async () => {
    const promise = watchCommand({ dir: "/tmp/test-project" });

    const output = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
    // Health score should be present (100 - 5 for 1 failed pending = 95)
    expect(output).toContain("95/100");
  });

  it("shows self-correction rate", async () => {
    const promise = watchCommand({ dir: "/tmp/test-project" });

    const output = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
    // 1 fixed out of 1 resolved (fixed + blocked) = 100%
    expect(output).toContain("100%");
    expect(output).toContain("Self-correction");
  });

  it("displays 'No events recorded' when events.log is empty", async () => {
    const promise = watchCommand({ dir: "/tmp/test-project" });

    const output = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
    expect(output).toContain("No events recorded");
  });

  it("displays recent events when events.log has content", async () => {
    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return CONFIG_CONTENT as never;
      if (path.endsWith("events.log"))
        return "2026-02-20 10:00:00 Worker 1 started\n2026-02-20 10:01:00 Task claimed" as never;
      return "" as never;
    });

    const promise = watchCommand({ dir: "/tmp/test-project" });

    const output = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
    expect(output).toContain("Worker 1 started");
    expect(output).toContain("Task claimed");
  });
});
