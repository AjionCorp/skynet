import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SkynetConfig, CompletedTask } from "../types";

// Mock DB
const mockDB = {
  getCompletedTasks: vi.fn((): CompletedTask[] => []),
};

vi.mock("../lib/db", () => ({
  getSkynetDB: vi.fn(() => mockDB),
}));

vi.mock("../lib/file-reader", () => ({
  readDevFile: vi.fn(() => ""),
}));

vi.mock("./pipeline-status", () => ({
  parseDurationMinutes: vi.fn((s: string): number | null => {
    const hm = s.match(/^(\d+)h\s+(\d+)m$/);
    if (hm) return Number(hm[1]) * 60 + Number(hm[2]);
    const hOnly = s.match(/^(\d+)h$/);
    if (hOnly) return Number(hOnly[1]) * 60;
    const mOnly = s.match(/^(\d+)m$/);
    if (mOnly) return Number(mOnly[1]);
    return null;
  }),
}));

import { createTaskVelocityHandler } from "./task-velocity";
import { readDevFile } from "../lib/file-reader";

const mockReadDevFile = vi.mocked(readDevFile);

function makeConfig(overrides?: Partial<SkynetConfig>): SkynetConfig {
  return {
    projectName: "test-project",
    devDir: "/tmp/test/.dev",
    lockPrefix: "/tmp/skynet-test-",
    workers: [],
    triggerableScripts: [],
    taskTags: ["FEAT", "FIX", "INFRA", "TEST", "NMI"],
    ...overrides,
  };
}

function makeTask(overrides?: Partial<CompletedTask>): CompletedTask {
  return {
    date: "2026-03-01",
    task: "Test task",
    branch: "feat/test",
    duration: "30m",
    notes: "",
    ...overrides,
  };
}

describe("createTaskVelocityHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDB.getCompletedTasks.mockReturnValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- SQLite path ---

  it("returns 200 with JSON content-type", async () => {
    const GET = createTaskVelocityHandler(makeConfig());
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
  });

  it("returns empty array when no completed tasks", async () => {
    const GET = createTaskVelocityHandler(makeConfig());
    const res = await GET();
    const body = await res.json();
    expect(body).toEqual({ data: [], error: null });
  });

  it("groups tasks by date from SQLite", async () => {
    mockDB.getCompletedTasks.mockReturnValue([
      makeTask({ date: "2026-03-01", duration: "30m" }),
      makeTask({ date: "2026-03-01", duration: "1h" }),
      makeTask({ date: "2026-03-02", duration: "45m" }),
    ]);

    const GET = createTaskVelocityHandler(makeConfig());
    const res = await GET();
    const body = await res.json();

    expect(body.error).toBeNull();
    expect(body.data).toHaveLength(2);
    expect(body.data[0]).toEqual({ date: "2026-03-01", count: 2, avgDurationMins: 45 });
    expect(body.data[1]).toEqual({ date: "2026-03-02", count: 1, avgDurationMins: 45 });
  });

  it("returns sorted results limited to last 14 days", async () => {
    const tasks: CompletedTask[] = [];
    for (let i = 1; i <= 20; i++) {
      const day = String(i).padStart(2, "0");
      tasks.push(makeTask({ date: `2026-01-${day}`, duration: "10m" }));
    }
    mockDB.getCompletedTasks.mockReturnValue(tasks);

    const GET = createTaskVelocityHandler(makeConfig());
    const res = await GET();
    const body = await res.json();

    expect(body.data).toHaveLength(14);
    expect(body.data[0].date).toBe("2026-01-07");
    expect(body.data[13].date).toBe("2026-01-20");
  });

  it("handles tasks with no duration gracefully", async () => {
    mockDB.getCompletedTasks.mockReturnValue([
      makeTask({ date: "2026-03-01", duration: "" }),
      makeTask({ date: "2026-03-01", duration: "" }),
    ]);

    const GET = createTaskVelocityHandler(makeConfig());
    const res = await GET();
    const body = await res.json();

    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toEqual({ date: "2026-03-01", count: 2, avgDurationMins: null });
  });

  it("skips tasks with no date", async () => {
    mockDB.getCompletedTasks.mockReturnValue([
      makeTask({ date: "", duration: "10m" }),
      makeTask({ date: "2026-03-01", duration: "20m" }),
    ]);

    const GET = createTaskVelocityHandler(makeConfig());
    const res = await GET();
    const body = await res.json();

    expect(body.data).toHaveLength(1);
    expect(body.data[0].count).toBe(1);
  });

  it("parses hours-and-minutes duration format", async () => {
    mockDB.getCompletedTasks.mockReturnValue([
      makeTask({ date: "2026-03-01", duration: "2h 15m" }),
    ]);

    const GET = createTaskVelocityHandler(makeConfig());
    const res = await GET();
    const body = await res.json();

    expect(body.data[0].avgDurationMins).toBe(135);
  });

  it("parses hours-only duration format", async () => {
    mockDB.getCompletedTasks.mockReturnValue([
      makeTask({ date: "2026-03-01", duration: "3h" }),
    ]);

    const GET = createTaskVelocityHandler(makeConfig());
    const res = await GET();
    const body = await res.json();

    expect(body.data[0].avgDurationMins).toBe(180);
  });

  // --- File fallback path ---

  it("falls back to file parsing when DB throws", async () => {
    mockDB.getCompletedTasks.mockImplementation(() => {
      throw new Error("DB unavailable");
    });

    mockReadDevFile.mockReturnValue(
      [
        "| Date | Task | Branch | Duration | Worker | Notes |",
        "| --- | --- | --- | --- | --- | --- |",
        "| 2026-03-01 | Fix bug | fix/bug | 25m | w1 | done |",
        "| 2026-03-01 | Add feat | feat/x | 1h | w2 | ok |",
        "| 2026-03-02 | Refactor | refactor/y | 45m | w1 | clean |",
      ].join("\n")
    );

    const GET = createTaskVelocityHandler(makeConfig());
    const res = await GET();
    const body = await res.json();

    expect(body.error).toBeNull();
    expect(body.data).toHaveLength(2);
    expect(body.data[0]).toEqual({ date: "2026-03-01", count: 2, avgDurationMins: 43 });
    expect(body.data[1]).toEqual({ date: "2026-03-02", count: 1, avgDurationMins: 45 });
  });

  it("file fallback handles empty completed.md", async () => {
    mockDB.getCompletedTasks.mockImplementation(() => {
      throw new Error("DB unavailable");
    });
    mockReadDevFile.mockReturnValue("");

    const GET = createTaskVelocityHandler(makeConfig());
    const res = await GET();
    const body = await res.json();

    expect(body).toEqual({ data: [], error: null });
  });

  it("file fallback skips header and separator lines", async () => {
    mockDB.getCompletedTasks.mockImplementation(() => {
      throw new Error("DB unavailable");
    });

    mockReadDevFile.mockReturnValue(
      [
        "| Date | Task | Branch | Duration | Worker | Notes |",
        "| --- | --- | --- | --- | --- | --- |",
        "| 2026-03-05 | Only task | feat/only | 15m | w1 | ok |",
      ].join("\n")
    );

    const GET = createTaskVelocityHandler(makeConfig());
    const res = await GET();
    const body = await res.json();

    expect(body.data).toHaveLength(1);
    expect(body.data[0].count).toBe(1);
  });

  // --- Outer error handling ---

  it("returns empty data on unexpected outer error", async () => {
    mockDB.getCompletedTasks.mockImplementation(() => {
      throw new Error("DB error");
    });
    mockReadDevFile.mockImplementation(() => {
      throw new Error("File error");
    });

    const GET = createTaskVelocityHandler(makeConfig());
    const res = await GET();
    const body = await res.json();

    expect(body).toEqual({ data: [], error: null });
  });
});
