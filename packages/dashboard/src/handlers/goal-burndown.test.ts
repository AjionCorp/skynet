import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createGoalBurndownHandler } from "./goal-burndown";
import type { SkynetConfig } from "../types";

vi.mock("fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ""),
}));

vi.mock("../lib/file-reader", () => ({
  readDevFile: vi.fn(() => ""),
}));

vi.mock("../lib/db", () => ({
  getSkynetDB: vi.fn(),
}));

vi.mock("../lib/handler-error", () => ({
  logHandlerError: vi.fn(),
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
    ? `http://localhost/api/mission/goal-burndown?slug=${slug}`
    : "http://localhost/api/mission/goal-burndown";
  return new Request(url, { method: "GET" });
}

function makeMockDB(overrides: Record<string, unknown> = {}) {
  return {
    getCompletedTasks: vi.fn(() => []),
    getBacklogItems: vi.fn(() => ({ items: [], pendingCount: 0, claimedCount: 0, manualDoneCount: 0 })),
    ...overrides,
  };
}

const MISSION_WITH_GOALS = `# Test Mission

## Goals
- [ ] Build dashboard components for monitoring
- [x] Create database integration layer
- [ ] Add deployment automation scripts
`;

describe("createGoalBurndownHandler", () => {
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

  // ── Response shape ──────────────────────────────────────────────

  it("returns { data, error: null } envelope on success", async () => {
    mockReadDevFile.mockReturnValue(MISSION_WITH_GOALS);
    mockGetSkynetDB.mockReturnValue(makeMockDB() as unknown as ReturnType<typeof getSkynetDB>);

    const handler = createGoalBurndownHandler(makeConfig());
    const res = await handler();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.error).toBeNull();
    expect(body.data).toBeDefined();
    expect(body.data.goals).toBeDefined();
    expect(body.data.overallMissionEta).toBeDefined();
  });

  it("returns overallMissionEta with correct shape", async () => {
    mockReadDevFile.mockReturnValue(MISSION_WITH_GOALS);
    mockGetSkynetDB.mockReturnValue(makeMockDB() as unknown as ReturnType<typeof getSkynetDB>);

    const handler = createGoalBurndownHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.overallMissionEta).toHaveProperty("etaDate");
    expect(data.overallMissionEta).toHaveProperty("etaDays");
    expect(data.overallMissionEta).toHaveProperty("confidence");
  });

  // ── No mission / no goals ──────────────────────────────────────

  it("returns empty goals and none confidence when no mission file", async () => {
    const handler = createGoalBurndownHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.goals).toEqual([]);
    expect(data.overallMissionEta).toEqual({ etaDate: null, etaDays: null, confidence: "none" });
  });

  it("returns empty goals and none confidence when mission has no Goals section", async () => {
    mockReadDevFile.mockReturnValue("# Mission\n\n## Purpose\nSome purpose.\n");
    mockGetSkynetDB.mockReturnValue(makeMockDB() as unknown as ReturnType<typeof getSkynetDB>);

    const handler = createGoalBurndownHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.goals).toEqual([]);
    expect(data.overallMissionEta).toEqual({ etaDate: null, etaDays: null, confidence: "none" });
  });

  // ── overallMissionEta: confidence "none" ───────────────────────

  it("returns confidence none when goals have remaining tasks but no velocity", async () => {
    mockReadDevFile.mockReturnValue(MISSION_WITH_GOALS);
    const db = makeMockDB({
      getCompletedTasks: vi.fn(() => []),
      getBacklogItems: vi.fn(() => ({
        items: [
          { text: "[FEAT] Build dashboard components for monitoring UI", status: "pending" },
        ],
        pendingCount: 1,
        claimedCount: 0,
        manualDoneCount: 0,
      })),
    });
    mockGetSkynetDB.mockReturnValue(db as unknown as ReturnType<typeof getSkynetDB>);

    const handler = createGoalBurndownHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    // No velocity means no ETA can be computed → confidence "none"
    expect(data.overallMissionEta.confidence).toBe("none");
    expect(data.overallMissionEta.etaDate).toBeNull();
    expect(data.overallMissionEta.etaDays).toBeNull();
  });

  // ── overallMissionEta: confidence "high" (all done) ────────────

  it("returns confidence high with etaDays 0 when all goals are complete", async () => {
    const allDoneMission = `# Mission

## Goals
- [x] Build dashboard components for monitoring
- [x] Create database integration layer
`;
    mockReadDevFile.mockReturnValue(allDoneMission);
    const todayStr = new Date().toISOString().slice(0, 10);
    const db = makeMockDB({
      getCompletedTasks: vi.fn(() => [
        { date: todayStr, task: "Build dashboard components for monitoring UI" },
        { date: todayStr, task: "Create database integration layer module" },
      ]),
      getBacklogItems: vi.fn(() => ({ items: [], pendingCount: 0, claimedCount: 0, manualDoneCount: 0 })),
    });
    mockGetSkynetDB.mockReturnValue(db as unknown as ReturnType<typeof getSkynetDB>);

    const handler = createGoalBurndownHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.overallMissionEta.confidence).toBe("high");
    expect(data.overallMissionEta.etaDays).toBe(0);
    expect(data.overallMissionEta.etaDate).toBe(todayStr);
  });

  // ── overallMissionEta: confidence "high" (all have ETA) ────────

  it("returns confidence high when all goals with remaining tasks have velocity", async () => {
    const mission = `# Mission

## Goals
- [ ] Build dashboard components for monitoring
- [ ] Create database integration layer
`;
    mockReadDevFile.mockReturnValue(mission);
    const today = new Date();
    const recentDates = Array.from({ length: 4 }, (_, i) => {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      return d.toISOString().slice(0, 10);
    });
    const db = makeMockDB({
      getCompletedTasks: vi.fn(() => [
        { date: recentDates[0], task: "Build dashboard components layout" },
        { date: recentDates[1], task: "Dashboard monitoring sidebar component" },
        { date: recentDates[2], task: "Create database integration helpers" },
        { date: recentDates[3], task: "Database integration connection layer" },
      ]),
      getBacklogItems: vi.fn(() => ({
        items: [
          { text: "[FEAT] Build dashboard monitoring charts", status: "pending" },
          { text: "[FEAT] Create database integration tests", status: "pending" },
        ],
        pendingCount: 2,
        claimedCount: 0,
        manualDoneCount: 0,
      })),
    });
    mockGetSkynetDB.mockReturnValue(db as unknown as ReturnType<typeof getSkynetDB>);

    const handler = createGoalBurndownHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.overallMissionEta.confidence).toBe("high");
    expect(data.overallMissionEta.etaDays).toBeGreaterThan(0);
    expect(data.overallMissionEta.etaDate).toBeTruthy();
  });

  // ── overallMissionEta: confidence "low" ────────────────────────

  it("returns confidence low when some goals have ETA but not all", async () => {
    const mission = `# Mission

## Goals
- [ ] Build dashboard components for monitoring
- [ ] Create database integration layer
`;
    mockReadDevFile.mockReturnValue(mission);
    const today = new Date();
    const recentDate = today.toISOString().slice(0, 10);
    const db = makeMockDB({
      // Only dashboard-related completed tasks → only first goal has velocity
      getCompletedTasks: vi.fn(() => [
        { date: recentDate, task: "Build dashboard components layout" },
        { date: recentDate, task: "Dashboard monitoring sidebar component" },
      ]),
      getBacklogItems: vi.fn(() => ({
        items: [
          { text: "[FEAT] Build dashboard monitoring charts", status: "pending" },
          { text: "[FEAT] Create database integration tests", status: "pending" },
        ],
        pendingCount: 2,
        claimedCount: 0,
        manualDoneCount: 0,
      })),
    });
    mockGetSkynetDB.mockReturnValue(db as unknown as ReturnType<typeof getSkynetDB>);

    const handler = createGoalBurndownHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.overallMissionEta.confidence).toBe("low");
    expect(data.overallMissionEta.etaDays).toBeGreaterThan(0);
  });

  // ── overallMissionEta: picks latest ETA ────────────────────────

  it("returns the latest per-goal ETA as overall mission ETA", async () => {
    const mission = `# Mission

## Goals
- [ ] Build dashboard components for monitoring
- [ ] Create database integration layer
`;
    mockReadDevFile.mockReturnValue(mission);
    const today = new Date();
    const recentDates = Array.from({ length: 5 }, (_, i) => {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      return d.toISOString().slice(0, 10);
    });
    const db = makeMockDB({
      getCompletedTasks: vi.fn(() => [
        // More dashboard completions → higher velocity for goal 1
        { date: recentDates[0], task: "Build dashboard components layout" },
        { date: recentDates[1], task: "Dashboard monitoring sidebar component" },
        { date: recentDates[2], task: "Build dashboard monitoring header" },
        // Fewer database completions → lower velocity for goal 2
        { date: recentDates[4], task: "Create database integration helpers" },
      ]),
      getBacklogItems: vi.fn(() => ({
        items: [
          { text: "[FEAT] Build dashboard monitoring charts", status: "pending" },
          { text: "[FEAT] Create database integration tests", status: "pending" },
          { text: "[FEAT] Create database integration migration", status: "pending" },
        ],
        pendingCount: 3,
        claimedCount: 0,
        manualDoneCount: 0,
      })),
    });
    mockGetSkynetDB.mockReturnValue(db as unknown as ReturnType<typeof getSkynetDB>);

    const handler = createGoalBurndownHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();

    // The overall ETA should be the max of per-goal ETAs
    const goalEtaDays = data.goals
      .filter((g: { etaDays: number | null }) => g.etaDays !== null)
      .map((g: { etaDays: number }) => g.etaDays);
    if (goalEtaDays.length > 0) {
      expect(data.overallMissionEta.etaDays).toBe(Math.max(...goalEtaDays));
    }
  });

  // ── Slug query parameter ───────────────────────────────────────

  it("reads mission from slug query parameter", async () => {
    mockExistsSync.mockReturnValue(false);
    mockReadDevFile.mockImplementation((_dir, filename) => {
      if (filename === "missions/feature-x.md") {
        return "# Feature X\n\n## Goals\n- [ ] Add feature X support\n";
      }
      return "";
    });
    mockGetSkynetDB.mockReturnValue(makeMockDB() as unknown as ReturnType<typeof getSkynetDB>);

    const handler = createGoalBurndownHandler(makeConfig());
    const res = await handler(makeRequest("feature-x"));
    const { data } = await res.json();
    expect(data.goals.length).toBe(1);
    expect(data.goals[0].goalText).toBe("Add feature X support");
  });

  // ── Active mission config fallback ─────────────────────────────

  it("falls back to activeMission from _config.json", async () => {
    mockExistsSync.mockImplementation((p) => {
      if (String(p).endsWith("_config.json")) return true;
      return false;
    });
    mockReadFileSync.mockImplementation((p) => {
      if (String(p).endsWith("_config.json")) return '{"activeMission":"main"}';
      return "";
    });
    mockReadDevFile.mockImplementation((_dir, filename) => {
      if (filename === "missions/main.md") {
        return "# Main\n\n## Goals\n- [ ] Ship v1\n";
      }
      return "";
    });
    mockGetSkynetDB.mockReturnValue(makeMockDB() as unknown as ReturnType<typeof getSkynetDB>);

    const handler = createGoalBurndownHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.goals.length).toBe(1);
    expect(data.goals[0].goalText).toBe("Ship v1");
  });

  // ── Error handling ─────────────────────────────────────────────

  it("returns 500 with error message in development mode", async () => {
    mockReadDevFile.mockImplementation(() => { throw new Error("Read failure"); });

    const handler = createGoalBurndownHandler(makeConfig());
    const res = await handler();
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.data).toBeNull();
    expect(body.error).toBe("Read failure");
  });

  it("returns generic error in production mode", async () => {
    process.env.NODE_ENV = "production";
    mockReadDevFile.mockImplementation(() => { throw new Error("Sensitive error"); });

    const handler = createGoalBurndownHandler(makeConfig());
    const res = await handler();
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.data).toBeNull();
    expect(body.error).toBe("Internal server error");
  });

  it("returns generic error when non-Error is thrown", async () => {
    mockReadDevFile.mockImplementation(() => { throw "unexpected string"; });

    const handler = createGoalBurndownHandler(makeConfig());
    const res = await handler();
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.data).toBeNull();
    expect(body.error).toBe("Internal error");
  });

  // ── File-based fallback ────────────────────────────────────────

  it("falls back to file-based parsing when DB is unavailable", async () => {
    mockReadDevFile.mockImplementation((_dir, filename) => {
      if (filename === "mission.md") return MISSION_WITH_GOALS;
      if (filename === "completed.md") return "| Date | Task |\n|---|---|\n| 2026-03-04 | Build dashboard components layout |\n";
      if (filename === "backlog.md") return "- [ ] [FEAT] Build dashboard monitoring charts\n";
      return "";
    });
    mockGetSkynetDB.mockImplementation(() => { throw new Error("DB not available"); });

    const handler = createGoalBurndownHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(res.status).toBe(200);
    expect(data.goals.length).toBe(3);
    expect(data.overallMissionEta).toBeDefined();
    expect(data.overallMissionEta.confidence).toBeDefined();
  });
});
