import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPipelineStatusHandler } from "./pipeline-status";
import type { SkynetConfig } from "../types";

vi.mock("../lib/file-reader", () => ({
  readDevFile: vi.fn(() => ""),
  getLastLogLine: vi.fn(() => null),
  extractTimestamp: vi.fn(() => null),
}));
vi.mock("../lib/worker-status", () => ({
  getWorkerStatus: vi.fn(() => ({ running: false, pid: null, ageMs: null })),
}));
vi.mock("fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ""),
  statSync: vi.fn(() => ({ mtimeMs: Date.now() })),
}));
vi.mock("child_process", () => ({
  execSync: vi.fn(() => ""),
}));

import { readDevFile, getLastLogLine, extractTimestamp } from "../lib/file-reader";
import { getWorkerStatus } from "../lib/worker-status";
import { existsSync, statSync, readFileSync } from "fs";
import { execSync } from "child_process";

const mockReadDevFile = vi.mocked(readDevFile);
const mockGetLastLogLine = vi.mocked(getLastLogLine);
const mockExtractTimestamp = vi.mocked(extractTimestamp);
const mockGetWorkerStatus = vi.mocked(getWorkerStatus);
const mockExistsSync = vi.mocked(existsSync);
const mockStatSync = vi.mocked(statSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockExecSync = vi.mocked(execSync);

function makeConfig(overrides?: Partial<SkynetConfig>): SkynetConfig {
  return {
    projectName: "test-project", devDir: "/tmp/test/.dev", lockPrefix: "/tmp/skynet-test-",
    workers: [{ name: "dev-worker-1", label: "Dev Worker 1", category: "core", schedule: "On demand", description: "Implements tasks" }],
    triggerableScripts: [], taskTags: ["FEAT", "FIX"], ...overrides,
  };
}

describe("createPipelineStatusHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadDevFile.mockReturnValue("");
    mockGetLastLogLine.mockReturnValue(null);
    mockExtractTimestamp.mockReturnValue(null);
    mockGetWorkerStatus.mockReturnValue({ running: false, pid: null, ageMs: null });
    mockExistsSync.mockReturnValue(false);
    mockExecSync.mockReturnValue("" as never);
  });

  it("returns { data, error: null } envelope on success", async () => {
    const handler = createPipelineStatusHandler(makeConfig());
    const res = await handler();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.error).toBeNull();
    expect(body.data).toBeDefined();
  });

  it("includes all expected top-level keys in data", async () => {
    const handler = createPipelineStatusHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data).toHaveProperty("workers");
    expect(data).toHaveProperty("currentTask");
    expect(data).toHaveProperty("backlog");
    expect(data).toHaveProperty("completed");
    expect(data).toHaveProperty("completedCount");
    expect(data).toHaveProperty("failed");
    expect(data).toHaveProperty("failedPendingCount");
    expect(data).toHaveProperty("hasBlockers");
    expect(data).toHaveProperty("blockerLines");
    expect(data).toHaveProperty("syncHealth");
    expect(data).toHaveProperty("auth");
    expect(data).toHaveProperty("backlogLocked");
    expect(data).toHaveProperty("git");
    expect(data).toHaveProperty("postCommitGate");
    expect(data).toHaveProperty("timestamp");
  });

  it("maps worker definitions with status info", async () => {
    mockGetWorkerStatus.mockReturnValue({ running: true, pid: 1234, ageMs: 5000 });
    mockGetLastLogLine.mockReturnValue("[2025-01-01 12:00:00] Task complete");
    mockExtractTimestamp.mockReturnValue("2025-01-01 12:00:00");
    const handler = createPipelineStatusHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.workers).toHaveLength(1);
    expect(data.workers[0].name).toBe("dev-worker-1");
    expect(data.workers[0].running).toBe(true);
    expect(data.workers[0].pid).toBe(1234);
  });

  it("parses current-task.md fields", async () => {
    mockReadDevFile.mockImplementation((_dir, filename) => {
      if (filename === "current-task.md") return "## Implement login page\n**Status:** running\n**Branch:** feat/login\n**Started:** 2025-01-01\n**Worker:** dev-worker-1";
      return "";
    });
    const handler = createPipelineStatusHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.currentTask.status).toBe("running");
    expect(data.currentTask.title).toBe("Implement login page");
    expect(data.currentTask.branch).toBe("feat/login");
  });

  it("parses backlog items with correct counts", async () => {
    mockReadDevFile.mockImplementation((_dir, filename) => {
      if (filename === "backlog.md") return "# Backlog\n\n- [ ] [FEAT] Add login\n- [>] [FIX] Fix bug\n- [x] [FEAT] Setup project";
      return "";
    });
    const handler = createPipelineStatusHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.backlog.pendingCount).toBe(1);
    expect(data.backlog.claimedCount).toBe(1);
    expect(data.backlog.doneCount).toBe(1);
  });

  it("detects blockers", async () => {
    mockReadDevFile.mockImplementation((_dir, filename) => {
      if (filename === "blockers.md") return "- Missing API key\n- Waiting on approval";
      return "";
    });
    const handler = createPipelineStatusHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.hasBlockers).toBe(true);
    expect(data.blockerLines).toHaveLength(2);
  });

  it("reports no blockers when content says No active blockers", async () => {
    mockReadDevFile.mockImplementation((_dir, filename) => {
      if (filename === "blockers.md") return "No active blockers";
      return "";
    });
    const handler = createPipelineStatusHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.hasBlockers).toBe(false);
  });

  it("reports auth status from filesystem checks", async () => {
    mockExistsSync.mockImplementation((p) => {
      if (typeof p === "string" && p.includes("claude-token")) return true;
      if (typeof p === "string" && p.includes("auth-failed")) return true;
      return false;
    });
    mockStatSync.mockReturnValue({ mtimeMs: Date.now() - 60000 } as ReturnType<typeof statSync>);
    mockReadFileSync.mockReturnValue("1704067200" as never);
    const handler = createPipelineStatusHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.auth.tokenCached).toBe(true);
    expect(data.auth.authFailFlag).toBe(true);
    expect(data.auth.lastFailEpoch).toBe(1704067200);
  });

  it("reports git status from execSync", async () => {
    mockExecSync.mockImplementation((cmd) => {
      const c = String(cmd);
      if (c.includes("rev-parse")) return "feat/login\n" as never;
      if (c.includes("rev-list")) return "3\n" as never;
      if (c.includes("status --porcelain")) return "M f1.ts\nM f2.ts\n" as never;
      if (c.includes("git log")) return "abc1234 Add login\n" as never;
      return "" as never;
    });
    const handler = createPipelineStatusHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.git.branch).toBe("feat/login");
    expect(data.git.commitsAhead).toBe(3);
    expect(data.git.dirtyFiles).toBe(2);
  });

  it("returns 500 with error envelope on failure", async () => {
    mockGetWorkerStatus.mockImplementation(() => { throw new Error("Lock file corrupted"); });
    const handler = createPipelineStatusHandler(makeConfig());
    const res = await handler();
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.data).toBeNull();
    expect(body.error).toBe("Lock file corrupted");
  });

  it("includes a valid ISO timestamp", async () => {
    const handler = createPipelineStatusHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(new Date(data.timestamp).toISOString()).toBe(data.timestamp);
  });

  it("parses completed.md table rows", async () => {
    mockReadDevFile.mockImplementation((_dir, filename) => {
      if (filename === "completed.md")
        return "| Date | Task | Branch | Notes |\n| --- | --- | --- | --- |\n| 2025-01-15 | Add login | feat/login | Merged |";
      return "";
    });
    const handler = createPipelineStatusHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.completed).toHaveLength(1);
    expect(data.completed[0].date).toBe("2025-01-15");
    expect(data.completed[0].task).toBe("Add login");
    expect(data.completed[0].branch).toBe("feat/login");
    expect(data.completedCount).toBe(1);
  });

  it("parses failed-tasks.md with status and counts pending failures", async () => {
    mockReadDevFile.mockImplementation((_dir, filename) => {
      if (filename === "failed-tasks.md")
        return "| Date | Task | Branch | Error | Attempts | Status |\n| --- | --- | --- | --- | --- | --- |\n| 2025-01-10 | Fix bug | fix/bug | Timeout | 3 | pending-retry |\n| 2025-01-09 | Add auth | feat/auth | OOM | 1 | resolved |";
      return "";
    });
    const handler = createPipelineStatusHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.failed).toHaveLength(2);
    expect(data.failed[0].error).toBe("Timeout");
    expect(data.failed[0].attempts).toBe("3");
    expect(data.failedPendingCount).toBe(1);
  });

  it("parses sync-health.md for lastRun and endpoints", async () => {
    mockReadDevFile.mockImplementation((_dir, filename) => {
      if (filename === "sync-health.md")
        return "_Last run: 2025-01-15 10:00_\n\n| Endpoint | Last Run | Status | Records | Notes |\n| --- | --- | --- | --- | --- |\n| /api/users | 10:00 | ok | 150 | - |";
      return "";
    });
    const handler = createPipelineStatusHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.syncHealth.lastRun).toBe("2025-01-15 10:00");
    expect(data.syncHealth.endpoints).toHaveLength(1);
    expect(data.syncHealth.endpoints[0].endpoint).toBe("/api/users");
    expect(data.syncHealth.endpoints[0].status).toBe("ok");
  });

  it("detects backlogLocked when lock directory exists", async () => {
    mockExistsSync.mockImplementation((p) => {
      if (typeof p === "string" && p.includes("backlog.lock")) return true;
      return false;
    });
    const handler = createPipelineStatusHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.backlogLocked).toBe(true);
  });

  it("parses post-commit gate log for pass result", async () => {
    mockGetLastLogLine.mockImplementation((_dir, script) => {
      if (script === "post-commit-gate") return "[2025-01-15 12:00:00] PASS abc1234 all checks green";
      return null;
    });
    mockExtractTimestamp.mockImplementation((line) => {
      if (line?.includes("2025-01-15")) return "2025-01-15 12:00:00";
      return null;
    });
    const handler = createPipelineStatusHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.postCommitGate.lastResult).toBe("pass");
    expect(data.postCommitGate.lastCommit).toBe("abc1234");
    expect(data.postCommitGate.lastTime).toBe("2025-01-15 12:00:00");
  });

  it("parses post-commit gate log for fail result", async () => {
    mockGetLastLogLine.mockImplementation((_dir, script) => {
      if (script === "post-commit-gate") return "[2025-01-15 12:00:00] FAIL def5678 typecheck error";
      return null;
    });
    mockExtractTimestamp.mockReturnValue("2025-01-15 12:00:00");
    const handler = createPipelineStatusHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.postCommitGate.lastResult).toBe("fail");
    expect(data.postCommitGate.lastCommit).toBe("def5678");
  });

  it("uses worker logFile override when provided", async () => {
    const config = makeConfig({
      workers: [{ name: "dev-worker-1", label: "Dev Worker 1", category: "core", schedule: "On demand", description: "Implements tasks", logFile: "custom-log" }],
    });
    const handler = createPipelineStatusHandler(config);
    await handler();
    const logNameCalls = mockGetLastLogLine.mock.calls.map((c) => c[1]);
    expect(logNameCalls).toContain("custom-log");
  });

  it("defaults worker category to 'core' when not specified", async () => {
    const config = makeConfig({
      workers: [{ name: "basic-worker", label: "Basic", schedule: "Hourly", description: "Basic worker" }],
    });
    const handler = createPipelineStatusHandler(config);
    const res = await handler();
    const { data } = await res.json();
    expect(data.workers[0].category).toBe("core");
  });

  it("returns empty completed and failed arrays when files are empty", async () => {
    const handler = createPipelineStatusHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.completed).toEqual([]);
    expect(data.completedCount).toBe(0);
    expect(data.failed).toEqual([]);
    expect(data.failedPendingCount).toBe(0);
  });

  it("returns null syncHealth.lastRun when no match", async () => {
    const handler = createPipelineStatusHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.syncHealth.lastRun).toBeNull();
    expect(data.syncHealth.endpoints).toEqual([]);
  });
});
