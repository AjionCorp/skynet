import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMetricsHandler } from "./metrics";
import type { SkynetConfig } from "../types";

// Mock DB with controllable return values
const mockDB = {
  countPending: vi.fn(() => 5),
  countByStatus: vi.fn((status: string) => {
    const counts: Record<string, number> = {
      pending: 5,
      claimed: 2,
      completed: 10,
      failed: 1,
      blocked: 0,
      superseded: 3,
    };
    return counts[status] ?? 0;
  }),
  calculateHealthScore: vi.fn(() => 85),
  countActiveWorkers: vi.fn(() => 2),
  getActiveBlockerCount: vi.fn(() => 1),
  countEvents: vi.fn(() => 42),
};

vi.mock("../lib/db", () => ({
  getSkynetDB: vi.fn(() => mockDB),
}));

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

describe("createMetricsHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset default mock implementations
    mockDB.countPending.mockReturnValue(5);
    mockDB.countByStatus.mockImplementation((status: string) => {
      const counts: Record<string, number> = {
        pending: 5,
        claimed: 2,
        completed: 10,
        failed: 1,
        blocked: 0,
        superseded: 3,
      };
      return counts[status] ?? 0;
    });
    mockDB.calculateHealthScore.mockReturnValue(85);
    mockDB.countActiveWorkers.mockReturnValue(2);
    mockDB.getActiveBlockerCount.mockReturnValue(1);
    mockDB.countEvents.mockReturnValue(42);
  });

  it("returns 200 with Prometheus content-type header", async () => {
    const GET = createMetricsHandler(makeConfig());
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe(
      "text/plain; version=0.0.4; charset=utf-8"
    );
  });

  it("returns expected metric names", async () => {
    const GET = createMetricsHandler(makeConfig());
    const res = await GET();
    const body = await res.text();

    expect(body).toContain("skynet_tasks_total");
    expect(body).toContain("skynet_health_score");
    expect(body).toContain("skynet_workers_active");
    expect(body).toContain("skynet_blockers_active");
    expect(body).toContain("skynet_events_total");
  });

  it("includes HELP and TYPE annotations for each metric", async () => {
    const GET = createMetricsHandler(makeConfig());
    const res = await GET();
    const body = await res.text();

    expect(body).toContain("# HELP skynet_tasks_total");
    expect(body).toContain("# TYPE skynet_tasks_total gauge");
    expect(body).toContain("# HELP skynet_health_score");
    expect(body).toContain("# TYPE skynet_health_score gauge");
    expect(body).toContain("# HELP skynet_workers_active");
    expect(body).toContain("# TYPE skynet_workers_active gauge");
    expect(body).toContain("# HELP skynet_blockers_active");
    expect(body).toContain("# TYPE skynet_blockers_active gauge");
    expect(body).toContain("# HELP skynet_events_total");
    expect(body).toContain("# TYPE skynet_events_total counter");
  });

  it("emits task counts for all statuses with numeric values", async () => {
    const GET = createMetricsHandler(makeConfig());
    const res = await GET();
    const body = await res.text();

    const statuses = ["pending", "claimed", "completed", "failed", "blocked", "superseded"];
    for (const status of statuses) {
      const regex = new RegExp(`skynet_tasks_total\\{status="${status}"\\} \\d+`);
      expect(body).toMatch(regex);
    }
  });

  it("returns correct metric values from DB", async () => {
    const GET = createMetricsHandler(makeConfig());
    const res = await GET();
    const body = await res.text();

    expect(body).toContain('skynet_tasks_total{status="pending"} 5');
    expect(body).toContain('skynet_tasks_total{status="claimed"} 2');
    expect(body).toContain('skynet_tasks_total{status="completed"} 10');
    expect(body).toContain('skynet_tasks_total{status="failed"} 1');
    expect(body).toContain('skynet_tasks_total{status="blocked"} 0');
    expect(body).toContain('skynet_tasks_total{status="superseded"} 3');
    expect(body).toContain("skynet_health_score 85");
    expect(body).toContain("skynet_workers_active 2");
    expect(body).toContain("skynet_blockers_active 1");
    expect(body).toContain("skynet_events_total 42");
  });

  it("all metric values are numeric", async () => {
    const GET = createMetricsHandler(makeConfig());
    const res = await GET();
    const body = await res.text();

    // Extract all metric lines (non-comment, non-empty)
    const metricLines = body
      .split("\n")
      .filter((line) => line && !line.startsWith("#"));

    expect(metricLines.length).toBeGreaterThan(0);

    for (const line of metricLines) {
      // Each metric line should end with a numeric value
      const value = line.split(" ").pop();
      expect(value).toBeDefined();
      expect(Number.isFinite(Number(value))).toBe(true);
    }
  });

  it("returns 200 with empty body when DB is unavailable", async () => {
    // Re-mock getSkynetDB to throw
    const { getSkynetDB } = await import("../lib/db");
    vi.mocked(getSkynetDB).mockImplementationOnce(() => {
      throw new Error("SQLite not available");
    });

    const GET = createMetricsHandler(makeConfig());
    const res = await GET();
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(body).toBe("");
  });

  it("returns 200 with empty body when countPending throws", async () => {
    mockDB.countPending.mockImplementationOnce(() => {
      throw new Error("Database locked");
    });

    const GET = createMetricsHandler(makeConfig());
    const res = await GET();
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(body).toBe("");
  });

  it("passes maxWorkers from config to calculateHealthScore", async () => {
    const GET = createMetricsHandler(makeConfig({ maxWorkers: 8 }));
    await GET();
    expect(mockDB.calculateHealthScore).toHaveBeenCalledWith(8, undefined);
  });

  it("defaults maxWorkers to 4 when not specified", async () => {
    const GET = createMetricsHandler(makeConfig());
    await GET();
    expect(mockDB.calculateHealthScore).toHaveBeenCalledWith(4, undefined);
  });

  it("passes staleMinutes from config to calculateHealthScore", async () => {
    const GET = createMetricsHandler(makeConfig({ staleMinutes: 15 }));
    await GET();
    expect(mockDB.calculateHealthScore).toHaveBeenCalledWith(4, 15);
  });

  it("returns valid Prometheus text exposition format", async () => {
    const GET = createMetricsHandler(makeConfig());
    const res = await GET();
    const body = await res.text();

    // Each metric group should be separated by empty lines
    // and HELP comes before TYPE
    const lines = body.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith("# HELP")) {
        // Next non-empty line should be # TYPE
        expect(lines[i + 1]).toMatch(/^# TYPE /);
      }
    }
  });
});
