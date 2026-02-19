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

import { readDevFile } from "../lib/file-reader";
import { execSync } from "child_process";

const mockReadDevFile = vi.mocked(readDevFile);
const mockExecSync = vi.mocked(execSync);

function makeConfig(overrides?: Partial<SkynetConfig>): SkynetConfig {
  return {
    projectName: "test-project",
    devDir: "/tmp/test/.dev",
    lockPrefix: "/tmp/skynet-test-",
    workers: [
      {
        name: "dev-worker-1",
        label: "Dev Worker 1",
        category: "core",
        schedule: "On demand",
        description: "Implements tasks",
      },
    ],
    triggerableScripts: [],
    taskTags: ["FEAT", "FIX"],
    ...overrides,
  };
}

/** Helper: call the handler and return parsed data */
async function callHandler(config?: SkynetConfig) {
  const handler = createPipelineStatusHandler(config ?? makeConfig());
  const res = await handler();
  return (await res.json()).data;
}

// ── Health Score Tests ───────────────────────────────────────────────────────

describe("health score calculation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadDevFile.mockReturnValue("");
    mockExecSync.mockReturnValue("" as never);
  });

  it("returns 100 when no failures, blockers, stale heartbeats, or stale tasks", async () => {
    const data = await callHandler();
    expect(data.healthScore).toBe(100);
  });

  it("subtracts 5 per pending failed task", async () => {
    mockReadDevFile.mockImplementation((_dir, filename) => {
      if (filename === "failed-tasks.md")
        return [
          "| Date | Task | Branch | Error | Attempts | Status |",
          "| --- | --- | --- | --- | --- | --- |",
          "| 2025-01-01 | Fix auth | fix/auth | timeout | 2 | pending |",
          "| 2025-01-02 | Fix nav | fix/nav | crash | 1 | pending |",
        ].join("\n");
      return "";
    });
    const data = await callHandler();
    expect(data.failedPendingCount).toBe(2);
    expect(data.healthScore).toBe(90); // 100 - 2*5
  });

  it("subtracts 10 per active blocker", async () => {
    mockReadDevFile.mockImplementation((_dir, filename) => {
      if (filename === "blockers.md")
        return "## Active\n\n- Missing API key\n- Waiting on approval\n- DNS not configured";
      return "";
    });
    const data = await callHandler();
    expect(data.blockerLines).toHaveLength(3);
    expect(data.healthScore).toBe(70); // 100 - 3*10
  });

  it("subtracts 2 per stale heartbeat", async () => {
    const oldEpoch = Math.floor((Date.now() - 60 * 60 * 1000) / 1000); // 1 hour ago (>45min stale threshold)
    mockReadDevFile.mockImplementation((_dir, filename) => {
      if (filename === "worker-1.heartbeat") return String(oldEpoch);
      if (filename === "worker-2.heartbeat") return String(oldEpoch);
      return "";
    });
    const data = await callHandler();
    expect(data.healthScore).toBe(96); // 100 - 2*2
  });

  it("subtracts 1 per task running longer than 24 hours", async () => {
    const oldDate = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(); // 30 hours ago
    mockReadDevFile.mockImplementation((_dir, filename) => {
      if (filename === "current-task-1.md")
        return `## Old task\n**Status:** running\n**Branch:** feat/old\n**Started:** ${oldDate}\n**Worker:** dev-worker-1`;
      return "";
    });
    const data = await callHandler();
    expect(data.healthScore).toBe(99); // 100 - 1*1
  });

  it("clamps score to 0 when deductions exceed 100", async () => {
    // 21 pending failed tasks = 105 deduction, but clamped to 0
    const failedLines = Array.from({ length: 21 }, (_, i) =>
      `| 2025-01-${String(i + 1).padStart(2, "0")} | Task ${i} | fix/t${i} | err | 1 | pending |`
    );
    mockReadDevFile.mockImplementation((_dir, filename) => {
      if (filename === "failed-tasks.md")
        return [
          "| Date | Task | Branch | Error | Attempts | Status |",
          "| --- | --- | --- | --- | --- | --- |",
          ...failedLines,
        ].join("\n");
      return "";
    });
    const data = await callHandler();
    expect(data.healthScore).toBe(0);
  });

  it("handles mixed deductions correctly", async () => {
    const oldEpoch = Math.floor((Date.now() - 60 * 60 * 1000) / 1000); // stale heartbeat
    const oldDate = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(); // stale task
    mockReadDevFile.mockImplementation((_dir, filename) => {
      if (filename === "failed-tasks.md")
        return [
          "| Date | Task | Branch | Error | Attempts | Status |",
          "| --- | --- | --- | --- | --- | --- |",
          "| 2025-01-01 | Fix auth | fix/auth | timeout | 2 | pending |",
        ].join("\n");
      if (filename === "blockers.md")
        return "## Active\n\n- Missing API key";
      if (filename === "worker-1.heartbeat") return String(oldEpoch);
      if (filename === "current-task-1.md")
        return `## Old task\n**Status:** running\n**Branch:** feat/old\n**Started:** ${oldDate}\n**Worker:** dev-worker-1`;
      return "";
    });
    const data = await callHandler();
    // 100 - 5 (1 failed pending) - 10 (1 blocker) - 2 (1 stale heartbeat) - 1 (1 stale task) = 82
    expect(data.healthScore).toBe(82);
  });

  it("does not deduct for failed tasks with non-pending status", async () => {
    mockReadDevFile.mockImplementation((_dir, filename) => {
      if (filename === "failed-tasks.md")
        return [
          "| Date | Task | Branch | Error | Attempts | Status |",
          "| --- | --- | --- | --- | --- | --- |",
          "| 2025-01-01 | Fix auth | fix/auth | timeout | 2 | resolved |",
          "| 2025-01-02 | Fix nav | fix/nav | crash | 1 | retried |",
        ].join("\n");
      return "";
    });
    const data = await callHandler();
    expect(data.failedPendingCount).toBe(0);
    expect(data.healthScore).toBe(100);
  });
});

// ── Backlog Item Parsing Tests ───────────────────────────────────────────────

describe("backlog item parsing with blockedBy metadata", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadDevFile.mockReturnValue("");
    mockExecSync.mockReturnValue("" as never);
  });

  it("parses blockedBy metadata from backlog items", async () => {
    mockReadDevFile.mockImplementation((_dir, filename) => {
      if (filename === "backlog.md")
        return "- [ ] [FEAT] Add dashboard | blockedBy: Setup auth, Add API";
      return "";
    });
    const data = await callHandler();
    const item = data.backlog.items[0];
    expect(item.blockedBy).toEqual(["Setup auth", "Add API"]);
  });

  it("marks item as blocked when dependency is not done", async () => {
    mockReadDevFile.mockImplementation((_dir, filename) => {
      if (filename === "backlog.md")
        return [
          "- [ ] [FEAT] Setup auth",
          "- [ ] [FEAT] Add dashboard | blockedBy: Setup auth",
        ].join("\n");
      return "";
    });
    const data = await callHandler();
    const dashboardItem = data.backlog.items.find(
      (i: { text: string }) => i.text.includes("Add dashboard")
    );
    expect(dashboardItem.blocked).toBe(true);
  });

  it("marks item as unblocked when all dependencies are done", async () => {
    mockReadDevFile.mockImplementation((_dir, filename) => {
      if (filename === "backlog.md")
        return [
          "- [x] [FEAT] Setup auth",
          "- [ ] [FEAT] Add dashboard | blockedBy: Setup auth",
        ].join("\n");
      return "";
    });
    const data = await callHandler();
    const dashboardItem = data.backlog.items.find(
      (i: { text: string }) => i.text.includes("Add dashboard")
    );
    expect(dashboardItem.blocked).toBe(false);
  });

  it("sets empty blockedBy array when no metadata present", async () => {
    mockReadDevFile.mockImplementation((_dir, filename) => {
      if (filename === "backlog.md") return "- [ ] [FEAT] Simple task";
      return "";
    });
    const data = await callHandler();
    expect(data.backlog.items[0].blockedBy).toEqual([]);
    expect(data.backlog.items[0].blocked).toBe(false);
  });
});

// ── Completed.md Duration Parsing Tests ──────────────────────────────────────

describe("completed.md duration parsing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadDevFile.mockReturnValue("");
    mockExecSync.mockReturnValue("" as never);
  });

  it("parses hours-and-minutes duration and computes average", async () => {
    mockReadDevFile.mockImplementation((_dir, filename) => {
      if (filename === "completed.md")
        return [
          "| Date | Task | Branch | Duration | Notes |",
          "| --- | --- | --- | --- | --- |",
          "| 2025-01-01 | Setup project | feat/setup | 1h 30m | Done |",
          "| 2025-01-02 | Add login | feat/login | 2h 30m | Done |",
        ].join("\n");
      return "";
    });
    const data = await callHandler();
    expect(data.completed).toHaveLength(2);
    expect(data.averageTaskDuration).toBe("2h"); // avg of 90 + 150 = 120m = 2h
  });

  it("parses minutes-only duration", async () => {
    mockReadDevFile.mockImplementation((_dir, filename) => {
      if (filename === "completed.md")
        return [
          "| Date | Task | Branch | Duration | Notes |",
          "| --- | --- | --- | --- | --- |",
          "| 2025-01-01 | Quick fix | fix/typo | 23m | Fast |",
        ].join("\n");
      return "";
    });
    const data = await callHandler();
    expect(data.averageTaskDuration).toBe("23m");
  });

  it("parses hours-only duration", async () => {
    mockReadDevFile.mockImplementation((_dir, filename) => {
      if (filename === "completed.md")
        return [
          "| Date | Task | Branch | Duration | Notes |",
          "| --- | --- | --- | --- | --- |",
          "| 2025-01-01 | Big refactor | refactor/all | 3h | Major |",
        ].join("\n");
      return "";
    });
    const data = await callHandler();
    expect(data.averageTaskDuration).toBe("3h");
  });

  it("returns null averageTaskDuration when no entries have duration data", async () => {
    mockReadDevFile.mockImplementation((_dir, filename) => {
      if (filename === "completed.md")
        return [
          "| Date | Task | Branch | Notes |",
          "| --- | --- | --- | --- |",
          "| 2025-01-01 | Old task | feat/old | No duration |",
        ].join("\n");
      return "";
    });
    const data = await callHandler();
    expect(data.averageTaskDuration).toBeNull();
  });
});

// ── Failed Task Status Categorization ────────────────────────────────────────

describe("failed task status categorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadDevFile.mockReturnValue("");
    mockExecSync.mockReturnValue("" as never);
  });

  it("categorizes failed tasks and counts only pending ones", async () => {
    mockReadDevFile.mockImplementation((_dir, filename) => {
      if (filename === "failed-tasks.md")
        return [
          "| Date | Task | Branch | Error | Attempts | Status |",
          "| --- | --- | --- | --- | --- | --- |",
          "| 2025-01-01 | Fix auth | fix/auth | timeout | 2 | pending |",
          "| 2025-01-02 | Fix nav | fix/nav | crash | 1 | resolved |",
          "| 2025-01-03 | Fix css | fix/css | lint | 3 | pending-review |",
        ].join("\n");
      return "";
    });
    const data = await callHandler();
    expect(data.failed).toHaveLength(3);
    // "pending" and "pending-review" both include "pending"
    expect(data.failedPendingCount).toBe(2);
  });

  it("returns empty failed array when no failed-tasks.md content", async () => {
    const data = await callHandler();
    expect(data.failed).toEqual([]);
    expect(data.failedPendingCount).toBe(0);
  });

  it("parses all fields of a failed task entry", async () => {
    mockReadDevFile.mockImplementation((_dir, filename) => {
      if (filename === "failed-tasks.md")
        return [
          "| Date | Task | Branch | Error | Attempts | Status |",
          "| --- | --- | --- | --- | --- | --- |",
          "| 2025-02-15 | Deploy API | deploy/api | OOM kill | 4 | pending |",
        ].join("\n");
      return "";
    });
    const data = await callHandler();
    const task = data.failed[0];
    expect(task.date).toBe("2025-02-15");
    expect(task.task).toBe("Deploy API");
    expect(task.branch).toBe("deploy/api");
    expect(task.error).toBe("OOM kill");
    expect(task.attempts).toBe("4");
    expect(task.status).toBe("pending");
  });
});
