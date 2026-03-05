import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockHandler } = vi.hoisted(() => ({
  mockHandler: vi.fn(async () =>
    Response.json({
      data: {
        goals: [
          {
            goalIndex: 0,
            goalText: "Build dashboard components",
            checked: false,
            relatedCompleted: 3,
            relatedRemaining: 2,
            burndown: [{ date: "2026-03-04", completed: 3 }],
            velocityPerDay: 0.43,
            etaDate: "2026-03-10",
            etaDays: 5,
          },
        ],
        overallMissionEta: {
          etaDate: "2026-03-10",
          etaDays: 5,
          confidence: "high",
        },
      },
      error: null,
    }),
  ),
}));

vi.mock("@ajioncorp/skynet/handlers", () => ({
  createGoalBurndownHandler: vi.fn(() => mockHandler),
}));

vi.mock("@/lib/skynet-config", () => ({
  config: {
    projectName: "test-project",
    devDir: "/tmp/test/.dev",
    lockPrefix: "/tmp/skynet-test-",
  },
}));

import { GET, dynamic } from "./route";
import { createGoalBurndownHandler } from "@ajioncorp/skynet/handlers";
import { config } from "@/lib/skynet-config";

const BASE_URL = "http://localhost/api/admin/mission/goal-burndown";

describe("mission/goal-burndown route wiring", () => {
  it("exports dynamic as force-dynamic", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  it("creates handler with the skynet config", () => {
    expect(createGoalBurndownHandler).toHaveBeenCalledWith(config);
  });

  it("exports GET as a function", () => {
    expect(typeof GET).toBe("function");
  });
});

describe("GET /api/admin/mission/goal-burndown", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delegates to handler and returns goal burndown data", async () => {
    const req = new Request(BASE_URL, { method: "GET" });
    const res = await GET(req);
    expect(mockHandler).toHaveBeenCalledTimes(1);
    expect(mockHandler).toHaveBeenCalledWith(req);
    const body = await res.json();
    expect(body.error).toBeNull();
    expect(body.data.goals).toHaveLength(1);
    expect(body.data.goals[0].goalText).toBe("Build dashboard components");
    expect(body.data.goals[0].relatedCompleted).toBe(3);
    expect(body.data.goals[0].relatedRemaining).toBe(2);
    expect(body.data.goals[0].burndown).toHaveLength(1);
    expect(body.data.overallMissionEta.confidence).toBe("high");
    expect(body.data.overallMissionEta.etaDays).toBe(5);
  });

  it("passes slug query parameter through to handler", async () => {
    const req = new Request(`${BASE_URL}?slug=feature-x`, { method: "GET" });
    await GET(req);
    expect(mockHandler).toHaveBeenCalledTimes(1);
    expect(mockHandler).toHaveBeenCalledWith(req);
  });
});
