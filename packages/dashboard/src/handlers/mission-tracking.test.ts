import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMissionTrackingHandler } from "./mission-tracking";
import type { SkynetConfig } from "../types";

vi.mock("fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ""),
  readdirSync: vi.fn(() => []),
}));

vi.mock("../lib/file-reader", () => ({
  readDevFile: vi.fn(() => ""),
}));

vi.mock("../lib/db", () => ({
  getSkynetDB: vi.fn(),
}));

import { existsSync, readFileSync } from "fs";
import { readDevFile } from "../lib/file-reader";
import { getSkynetDB } from "../lib/db";

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockReadDevFile = vi.mocked(readDevFile);
const mockGetSkynetDB = vi.mocked(getSkynetDB);

function makeConfig(overrides?: Partial<SkynetConfig>): SkynetConfig {
  return {
    projectName: "test-project",
    devDir: "/tmp/test/.dev",
    lockPrefix: "/tmp/skynet-test-",
    workers: [],
    triggerableScripts: [],
    taskTags: [],
    ...overrides,
  };
}

function makeRequest(slug?: string): Request {
  const url = slug
    ? `http://localhost/api/mission/tracking?slug=${slug}`
    : "http://localhost/api/mission/tracking";
  return new Request(url, { method: "GET" });
}

function makeMockDB(overrides: Record<string, unknown> = {}) {
  return {
    countPending: vi.fn(() => 0),
    getBacklogItems: vi.fn(() => ({ items: [], pendingCount: 0, claimedCount: 0, manualDoneCount: 0 })),
    getCompletedCount: vi.fn(() => 0),
    getCompletedTasks: vi.fn(() => []),
    getFailedTasks: vi.fn(() => []),
    getAllCurrentTasks: vi.fn(() => ({})),
    ...overrides,
  };
}

describe("createMissionTrackingHandler", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.NODE_ENV = "development";
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockReturnValue("");
    mockReadDevFile.mockReturnValue("");
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  // ── No mission scenarios ──────────────────────────────────────────

  it("returns no-mission status when no config file and no slug", async () => {
    // existsSync returns false for config and mission file
    const handler = createMissionTrackingHandler(makeConfig());
    const res = await handler();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.error).toBeNull();
    expect(body.data.trackingStatus).toBe("no-mission");
    expect(body.data.slug).toBe("");
    expect(body.data.trackingMessage).toBe("No active mission configured");
  });

  it("returns no-mission when slug is provided but mission file does not exist", async () => {
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("_config.json")) return true;
      return false;
    });
    mockReadFileSync.mockImplementation((p) => {
      if (String(p).endsWith("_config.json")) return '{"activeMission":"main","assignments":{}}';
      return "";
    });

    const handler = createMissionTrackingHandler(makeConfig());
    const res = await handler(makeRequest("nonexistent"));
    const body = await res.json();
    expect(body.data.trackingStatus).toBe("no-mission");
  });

  it("returns no-mission when activeMission slug file does not exist", async () => {
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("_config.json")) return true;
      if (path.endsWith("main.md")) return false;
      return false;
    });
    mockReadFileSync.mockImplementation((p) => {
      if (String(p).endsWith("_config.json")) return '{"activeMission":"main","assignments":{}}';
      return "";
    });

    const handler = createMissionTrackingHandler(makeConfig());
    const res = await handler();
    const body = await res.json();
    expect(body.data.trackingStatus).toBe("no-mission");
  });

  // ── Basic response shape ──────────────────────────────────────────

  it("returns { data, error: null } envelope on success with valid mission", async () => {
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("_config.json")) return true;
      if (path.endsWith("main.md")) return true;
      return false;
    });
    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("_config.json")) return '{"activeMission":"main","assignments":{}}';
      if (path.endsWith("main.md")) return "# Main Mission\n\n## Success Criteria\n- [ ] Task one\n";
      return "";
    });
    mockGetSkynetDB.mockReturnValue(makeMockDB() as unknown as ReturnType<typeof getSkynetDB>);

    const handler = createMissionTrackingHandler(makeConfig());
    const res = await handler();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.error).toBeNull();
    expect(body.data).toBeDefined();
    expect(body.data.slug).toBe("main");
    expect(body.data.name).toBe("Main Mission");
  });

  it("includes all expected MissionTracking keys", async () => {
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("_config.json")) return true;
      if (path.endsWith("main.md")) return true;
      return false;
    });
    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("_config.json")) return '{"activeMission":"main","assignments":{}}';
      return "# Main\n";
    });
    mockGetSkynetDB.mockReturnValue(makeMockDB() as unknown as ReturnType<typeof getSkynetDB>);

    const handler = createMissionTrackingHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();

    const expectedKeys = [
      "slug", "name", "assignedWorkers", "activeWorkers", "idleWorkers",
      "backlogCount", "inProgressCount", "completedCount", "completedLast24h",
      "failedPendingCount", "criteriaTotal", "criteriaMet", "completionPercentage",
      "trackingStatus", "trackingMessage",
    ];
    for (const key of expectedKeys) {
      expect(data).toHaveProperty(key);
    }
  });

  // ── Mission name parsing ──────────────────────────────────────────

  it("parses mission name from markdown heading", async () => {
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("_config.json")) return true;
      if (path.endsWith("main.md")) return true;
      return false;
    });
    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("_config.json")) return '{"activeMission":"main","assignments":{}}';
      return "# Deploy Pipeline v2\n\nSome content\n";
    });
    mockGetSkynetDB.mockReturnValue(makeMockDB() as unknown as ReturnType<typeof getSkynetDB>);

    const handler = createMissionTrackingHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.name).toBe("Deploy Pipeline v2");
  });

  it("uses slug as name when no heading is present", async () => {
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("_config.json")) return true;
      if (path.endsWith("main.md")) return true;
      return false;
    });
    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("_config.json")) return '{"activeMission":"main","assignments":{}}';
      return "Just some text without a heading.\n";
    });
    mockGetSkynetDB.mockReturnValue(makeMockDB() as unknown as ReturnType<typeof getSkynetDB>);

    const handler = createMissionTrackingHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.name).toBe("main");
  });

  // ── Success criteria counting ─────────────────────────────────────

  it("counts success criteria checkboxes correctly", async () => {
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("_config.json")) return true;
      if (path.endsWith("main.md")) return true;
      return false;
    });
    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("_config.json")) return '{"activeMission":"main","assignments":{}}';
      return "# Main\n\n## Success Criteria\n- [x] Done one\n- [ ] Not done\n- [X] Done two\n";
    });
    mockGetSkynetDB.mockReturnValue(makeMockDB() as unknown as ReturnType<typeof getSkynetDB>);

    const handler = createMissionTrackingHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.criteriaTotal).toBe(3);
    expect(data.criteriaMet).toBe(2);
    expect(data.completionPercentage).toBe(67);
  });

  it("returns 0% when no success criteria section exists", async () => {
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("_config.json")) return true;
      if (path.endsWith("main.md")) return true;
      return false;
    });
    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("_config.json")) return '{"activeMission":"main","assignments":{}}';
      return "# Main\n\n## Purpose\nJust a purpose.\n";
    });
    mockGetSkynetDB.mockReturnValue(makeMockDB() as unknown as ReturnType<typeof getSkynetDB>);

    const handler = createMissionTrackingHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.criteriaTotal).toBe(0);
    expect(data.criteriaMet).toBe(0);
    expect(data.completionPercentage).toBe(0);
  });

  it("returns 100% when all criteria are checked", async () => {
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("_config.json")) return true;
      if (path.endsWith("main.md")) return true;
      return false;
    });
    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("_config.json")) return '{"activeMission":"main","assignments":{}}';
      return "# Main\n\n## Success Criteria\n- [x] Tests pass\n- [x] Docs done\n";
    });
    mockGetSkynetDB.mockReturnValue(makeMockDB() as unknown as ReturnType<typeof getSkynetDB>);

    const handler = createMissionTrackingHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.completionPercentage).toBe(100);
  });

  // ── Slug from query parameter ─────────────────────────────────────

  it("uses slug from query parameter over activeMission", async () => {
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("_config.json")) return true;
      if (path.endsWith("feature-x.md")) return true;
      return false;
    });
    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("_config.json")) return '{"activeMission":"main","assignments":{}}';
      if (path.endsWith("feature-x.md")) return "# Feature X\n";
      return "";
    });
    mockGetSkynetDB.mockReturnValue(makeMockDB() as unknown as ReturnType<typeof getSkynetDB>);

    const handler = createMissionTrackingHandler(makeConfig());
    const res = await handler(makeRequest("feature-x"));
    const { data } = await res.json();
    expect(data.slug).toBe("feature-x");
    expect(data.name).toBe("Feature X");
  });

  it("falls back to activeMission when no slug in query", async () => {
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("_config.json")) return true;
      if (path.endsWith("main.md")) return true;
      return false;
    });
    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("_config.json")) return '{"activeMission":"main","assignments":{}}';
      return "# Main\n";
    });
    mockGetSkynetDB.mockReturnValue(makeMockDB() as unknown as ReturnType<typeof getSkynetDB>);

    const handler = createMissionTrackingHandler(makeConfig());
    const res = await handler(makeRequest());
    const { data } = await res.json();
    expect(data.slug).toBe("main");
  });

  // ── Worker assignments ────────────────────────────────────────────

  it("counts assigned workers for the mission", async () => {
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("_config.json")) return true;
      if (path.endsWith("main.md")) return true;
      return false;
    });
    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("_config.json")) return '{"activeMission":"main","assignments":{"dev-worker-1":"main","dev-worker-2":"main","dev-worker-3":"other"}}';
      return "# Main\n";
    });
    mockGetSkynetDB.mockReturnValue(makeMockDB() as unknown as ReturnType<typeof getSkynetDB>);

    const handler = createMissionTrackingHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.assignedWorkers).toBe(2);
  });

  // ── Tracking status: no-workers ───────────────────────────────────

  it("returns no-workers status when no workers assigned", async () => {
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("_config.json")) return true;
      if (path.endsWith("main.md")) return true;
      return false;
    });
    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("_config.json")) return '{"activeMission":"main","assignments":{}}';
      return "# Main\n";
    });
    mockGetSkynetDB.mockReturnValue(makeMockDB() as unknown as ReturnType<typeof getSkynetDB>);

    const handler = createMissionTrackingHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.trackingStatus).toBe("no-workers");
    expect(data.trackingMessage).toContain("No workers assigned");
  });

  // ── Tracking status: idle ─────────────────────────────────────────

  it("returns idle status when workers assigned but no tasks in pipeline", async () => {
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("_config.json")) return true;
      if (path.endsWith("main.md")) return true;
      return false;
    });
    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("_config.json")) return '{"activeMission":"main","assignments":{"dev-worker-1":"main"}}';
      return "# Main\n";
    });
    mockGetSkynetDB.mockReturnValue(makeMockDB() as unknown as ReturnType<typeof getSkynetDB>);

    const handler = createMissionTrackingHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.trackingStatus).toBe("idle");
    expect(data.trackingMessage).toContain("assigned but no tasks");
  });

  // ── Tracking status: stalled ──────────────────────────────────────

  it("returns stalled status when backlog exists but no active workers and no recent completions", async () => {
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("_config.json")) return true;
      if (path.endsWith("main.md")) return true;
      return false;
    });
    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("_config.json")) return '{"activeMission":"main","assignments":{"dev-worker-1":"main"}}';
      return "# Main\n";
    });
    const db = makeMockDB({
      getBacklogItems: vi.fn(() => ({ items: [], pendingCount: 5, claimedCount: 0, manualDoneCount: 0 })),
      getCompletedTasks: vi.fn(() => []),
    });
    mockGetSkynetDB.mockReturnValue(db as unknown as ReturnType<typeof getSkynetDB>);

    const handler = createMissionTrackingHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.trackingStatus).toBe("stalled");
    expect(data.trackingMessage).toContain("queued but no progress");
  });

  // ── Tracking status: on-track ─────────────────────────────────────

  it("returns on-track status when workers are active", async () => {
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("_config.json")) return true;
      if (path.endsWith("main.md")) return true;
      return false;
    });
    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("_config.json")) return '{"activeMission":"main","assignments":{"dev-worker-1":"main"}}';
      return "# Main\n";
    });
    const db = makeMockDB({
      getBacklogItems: vi.fn(() => ({ items: [], pendingCount: 3, claimedCount: 1, manualDoneCount: 0 })),
      getAllCurrentTasks: vi.fn(() => ({
        "worker-1": { status: "in_progress", title: "Some task", branch: "feat/x", started: null, worker: "Worker 1", lastInfo: null },
      })),
    });
    mockGetSkynetDB.mockReturnValue(db as unknown as ReturnType<typeof getSkynetDB>);

    const handler = createMissionTrackingHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.trackingStatus).toBe("on-track");
    expect(data.activeWorkers).toBe(1);
    expect(data.trackingMessage).toContain("active");
  });

  it("includes completed today and queued counts in on-track message", async () => {
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("_config.json")) return true;
      if (path.endsWith("main.md")) return true;
      return false;
    });
    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("_config.json")) return '{"activeMission":"main","assignments":{"dev-worker-1":"main"}}';
      return "# Main\n";
    });
    const recentDate = new Date().toISOString().slice(0, 10);
    const db = makeMockDB({
      getBacklogItems: vi.fn(() => ({ items: [], pendingCount: 2, claimedCount: 0, manualDoneCount: 0 })),
      getCompletedTasks: vi.fn(() => [
        { date: recentDate, task: "Task A", branch: "", duration: "", notes: "" },
        { date: recentDate, task: "Task B", branch: "", duration: "", notes: "" },
      ]),
      getAllCurrentTasks: vi.fn(() => ({
        "worker-1": { status: "in_progress", title: "Active task", branch: "feat/y", started: null, worker: "Worker 1", lastInfo: null },
      })),
    });
    mockGetSkynetDB.mockReturnValue(db as unknown as ReturnType<typeof getSkynetDB>);

    const handler = createMissionTrackingHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.trackingStatus).toBe("on-track");
    expect(data.completedLast24h).toBe(2);
    expect(data.trackingMessage).toContain("completed today");
    expect(data.trackingMessage).toContain("queued");
  });

  // ── DB task data ──────────────────────────────────────────────────

  it("reads task counts from SQLite database", async () => {
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("_config.json")) return true;
      if (path.endsWith("main.md")) return true;
      return false;
    });
    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("_config.json")) return '{"activeMission":"main","assignments":{"dev-worker-1":"main"}}';
      return "# Main\n";
    });
    const db = makeMockDB({
      getBacklogItems: vi.fn(() => ({ items: [], pendingCount: 10, claimedCount: 2, manualDoneCount: 0 })),
      getCompletedCount: vi.fn(() => 15),
      getFailedTasks: vi.fn(() => [
        { date: "", task: "Fix A", branch: "", error: "", attempts: "1", status: "fixing-1" },
        { date: "", task: "Fix B", branch: "", error: "", attempts: "2", status: "failed" },
      ]),
    });
    mockGetSkynetDB.mockReturnValue(db as unknown as ReturnType<typeof getSkynetDB>);

    const handler = createMissionTrackingHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.backlogCount).toBe(10);
    expect(data.inProgressCount).toBe(2);
    expect(data.completedCount).toBe(15);
    expect(data.failedPendingCount).toBe(1); // only fixing-1 matches
  });

  it("counts failed tasks with pending status and fixing- prefix", async () => {
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("_config.json")) return true;
      if (path.endsWith("main.md")) return true;
      return false;
    });
    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("_config.json")) return '{"activeMission":"main","assignments":{"dev-worker-1":"main"}}';
      return "# Main\n";
    });
    const db = makeMockDB({
      getFailedTasks: vi.fn(() => [
        { date: "", task: "A", branch: "", error: "", attempts: "1", status: "fixing-2" },
        { date: "", task: "B", branch: "", error: "", attempts: "1", status: "blocked" },
        { date: "", task: "C", branch: "", error: "", attempts: "1", status: "fixed" },
        { date: "", task: "D", branch: "", error: "", attempts: "1", status: "superseded" },
      ]),
    });
    mockGetSkynetDB.mockReturnValue(db as unknown as ReturnType<typeof getSkynetDB>);

    const handler = createMissionTrackingHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.failedPendingCount).toBe(1); // only fixing-2
  });

  // ── File-based fallback ───────────────────────────────────────────

  it("falls back to file-based counts when DB is unavailable", async () => {
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("_config.json")) return true;
      if (path.endsWith("main.md")) return true;
      return false;
    });
    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("_config.json")) return '{"activeMission":"main","assignments":{"dev-worker-1":"main"}}';
      return "# Main\n";
    });
    mockGetSkynetDB.mockImplementation(() => { throw new Error("DB not available"); });
    mockReadDevFile.mockImplementation((_dir, filename) => {
      if (filename === "backlog.md") return "- [ ] Task one\n- [ ] Task two\n- [>] Claimed task\n";
      if (filename === "current-task-1.md") return "status: in_progress\ntitle: Active task\n";
      return "";
    });

    const handler = createMissionTrackingHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.backlogCount).toBe(2); // only "- [ ]" lines
    expect(data.inProgressCount).toBe(1);
  });

  it("detects active workers from current-task files in fallback mode", async () => {
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("_config.json")) return true;
      if (path.endsWith("main.md")) return true;
      return false;
    });
    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("_config.json")) return '{"activeMission":"main","assignments":{"dev-worker-1":"main","dev-worker-2":"main"}}';
      return "# Main\n";
    });
    mockGetSkynetDB.mockImplementation(() => { throw new Error("DB not available"); });
    mockReadDevFile.mockImplementation((_dir, filename) => {
      if (filename === "backlog.md") return "";
      if (filename === "current-task-1.md") return "status: in_progress\ntitle: Task A\n";
      if (filename === "current-task-2.md") return "status: idle\n";
      return "";
    });

    const handler = createMissionTrackingHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.activeWorkers).toBe(1);
    expect(data.idleWorkers).toBe(1);
  });

  // ── Active worker detection from DB ───────────────────────────────

  it("detects active workers from DB current tasks", async () => {
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("_config.json")) return true;
      if (path.endsWith("main.md")) return true;
      return false;
    });
    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("_config.json")) return '{"activeMission":"main","assignments":{"dev-worker-1":"main","dev-worker-2":"main","dev-worker-3":"main"}}';
      return "# Main\n";
    });
    const db = makeMockDB({
      getAllCurrentTasks: vi.fn(() => ({
        "worker-1": { status: "in_progress", title: "Task A", branch: "feat/a", started: null, worker: "Worker 1", lastInfo: null },
        "worker-2": { status: "idle", title: null, branch: null, started: null, worker: "Worker 2", lastInfo: null },
        "worker-3": { status: "in_progress", title: "Task B", branch: "feat/b", started: null, worker: "Worker 3", lastInfo: null },
      })),
    });
    mockGetSkynetDB.mockReturnValue(db as unknown as ReturnType<typeof getSkynetDB>);

    const handler = createMissionTrackingHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.activeWorkers).toBe(2);
    expect(data.idleWorkers).toBe(1);
  });

  // ── maxWorkers config ─────────────────────────────────────────────

  it("uses maxWorkers from config for worker iteration", async () => {
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("_config.json")) return true;
      if (path.endsWith("main.md")) return true;
      return false;
    });
    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("_config.json")) return '{"activeMission":"main","assignments":{"dev-worker-1":"main"}}';
      return "# Main\n";
    });
    const db = makeMockDB();
    mockGetSkynetDB.mockReturnValue(db as unknown as ReturnType<typeof getSkynetDB>);

    const handler = createMissionTrackingHandler(makeConfig({ maxWorkers: 6 }));
    const res = await handler();
    await res.json();
    expect(db.getAllCurrentTasks).toHaveBeenCalledWith(6);
  });

  it("defaults maxWorkers to 4 when not specified", async () => {
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("_config.json")) return true;
      if (path.endsWith("main.md")) return true;
      return false;
    });
    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("_config.json")) return '{"activeMission":"main","assignments":{"dev-worker-1":"main"}}';
      return "# Main\n";
    });
    const db = makeMockDB();
    mockGetSkynetDB.mockReturnValue(db as unknown as ReturnType<typeof getSkynetDB>);

    const handler = createMissionTrackingHandler(makeConfig());
    const res = await handler();
    await res.json();
    expect(db.getAllCurrentTasks).toHaveBeenCalledWith(4);
  });

  // ── Idle workers calculation ──────────────────────────────────────

  it("calculates idleWorkers as assigned minus active", async () => {
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("_config.json")) return true;
      if (path.endsWith("main.md")) return true;
      return false;
    });
    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("_config.json")) return '{"activeMission":"main","assignments":{"dev-worker-1":"main","dev-worker-2":"main","dev-worker-3":"main"}}';
      return "# Main\n";
    });
    const db = makeMockDB({
      getAllCurrentTasks: vi.fn(() => ({
        "worker-1": { status: "in_progress", title: "Task", branch: "feat/x", started: null, worker: "Worker 1", lastInfo: null },
      })),
    });
    mockGetSkynetDB.mockReturnValue(db as unknown as ReturnType<typeof getSkynetDB>);

    const handler = createMissionTrackingHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.assignedWorkers).toBe(3);
    expect(data.activeWorkers).toBe(1);
    expect(data.idleWorkers).toBe(2);
  });

  // ── Completed last 24h filtering ──────────────────────────────────

  it("filters completed tasks by last 24 hours", async () => {
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("_config.json")) return true;
      if (path.endsWith("main.md")) return true;
      return false;
    });
    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("_config.json")) return '{"activeMission":"main","assignments":{"dev-worker-1":"main"}}';
      return "# Main\n";
    });
    const recentDate = new Date().toISOString();
    const oldDate = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const db = makeMockDB({
      getCompletedTasks: vi.fn(() => [
        { date: recentDate, task: "Recent", branch: "", duration: "", notes: "" },
        { date: oldDate, task: "Old", branch: "", duration: "", notes: "" },
        { date: null, task: "No date", branch: "", duration: "", notes: "" },
      ]),
    });
    mockGetSkynetDB.mockReturnValue(db as unknown as ReturnType<typeof getSkynetDB>);

    const handler = createMissionTrackingHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.completedLast24h).toBe(1);
  });

  // ── No request (called without Request object) ────────────────────

  it("works when called without a request object", async () => {
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("_config.json")) return true;
      if (path.endsWith("main.md")) return true;
      return false;
    });
    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("_config.json")) return '{"activeMission":"main","assignments":{}}';
      return "# Main\n";
    });
    mockGetSkynetDB.mockReturnValue(makeMockDB() as unknown as ReturnType<typeof getSkynetDB>);

    const handler = createMissionTrackingHandler(makeConfig());
    const res = await handler();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.slug).toBe("main");
  });

  // ── Error handling ────────────────────────────────────────────────

  it("returns 500 with error message in development mode", async () => {
    mockExistsSync.mockImplementation(() => { throw new Error("Disk read error"); });

    const handler = createMissionTrackingHandler(makeConfig());
    const res = await handler();
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.data).toBeNull();
    expect(body.error).toBe("Disk read error");
  });

  it("returns generic error in production mode", async () => {
    process.env.NODE_ENV = "production";
    mockExistsSync.mockImplementation(() => { throw new Error("Sensitive error"); });

    const handler = createMissionTrackingHandler(makeConfig());
    const res = await handler();
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.data).toBeNull();
    expect(body.error).toBe("Internal server error");
  });

  it("returns generic error when non-Error is thrown", async () => {
    mockExistsSync.mockImplementation(() => { throw "unexpected string"; });

    const handler = createMissionTrackingHandler(makeConfig());
    const res = await handler();
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.data).toBeNull();
    expect(body.error).toBe("Internal error");
  });

  // ── Mission config fallback ───────────────────────────────────────

  it("returns defaults when _config.json does not exist", async () => {
    // No config file, no mission files → no-mission
    mockExistsSync.mockReturnValue(false);
    const handler = createMissionTrackingHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.trackingStatus).toBe("no-mission");
  });

  it("returns defaults when _config.json contains invalid JSON", async () => {
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("_config.json")) return true;
      return false;
    });
    mockReadFileSync.mockImplementation((p) => {
      if (String(p).endsWith("_config.json")) return "not valid json{{{";
      return "";
    });

    const handler = createMissionTrackingHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    // Falls back to default config with activeMission: "main"
    // but main.md doesn't exist → no-mission
    expect(data.trackingStatus).toBe("no-mission");
  });

  // ── Success criteria parsing edge cases ───────────────────────────

  it("stops parsing criteria at next ## section", async () => {
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("_config.json")) return true;
      if (path.endsWith("main.md")) return true;
      return false;
    });
    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("_config.json")) return '{"activeMission":"main","assignments":{}}';
      return "# Main\n\n## Success Criteria\n- [x] Done\n- [ ] Not done\n\n## Other Section\n- [ ] This should not count\n";
    });
    mockGetSkynetDB.mockReturnValue(makeMockDB() as unknown as ReturnType<typeof getSkynetDB>);

    const handler = createMissionTrackingHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.criteriaTotal).toBe(2);
    expect(data.criteriaMet).toBe(1);
  });

  it("ignores non-checkbox lines in success criteria section", async () => {
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("_config.json")) return true;
      if (path.endsWith("main.md")) return true;
      return false;
    });
    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("_config.json")) return '{"activeMission":"main","assignments":{}}';
      return "# Main\n\n## Success Criteria\n\nSome description text\n- [x] Criterion one\n- Plain list item\n- [ ] Criterion two\n";
    });
    mockGetSkynetDB.mockReturnValue(makeMockDB() as unknown as ReturnType<typeof getSkynetDB>);

    const handler = createMissionTrackingHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.criteriaTotal).toBe(2);
    expect(data.criteriaMet).toBe(1);
  });
});
