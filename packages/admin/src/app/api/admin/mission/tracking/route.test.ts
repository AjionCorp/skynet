import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockHandler } = vi.hoisted(() => ({
  mockHandler: vi.fn(async () =>
    Response.json({
      data: {
        slug: "main",
        name: "Main Mission",
        assignedWorkers: 2,
        activeWorkers: 1,
        idleWorkers: 1,
        backlogCount: 5,
        inProgressCount: 1,
        completedCount: 10,
        completedLast24h: 3,
        failedPendingCount: 0,
        criteriaTotal: 4,
        criteriaMet: 2,
        completionPercentage: 50,
        trackingStatus: "on-track",
        trackingMessage: "1 worker(s) active, 3 completed today, 5 queued",
      },
      error: null,
    }),
  ),
}));

vi.mock("@ajioncorp/skynet/handlers", () => ({
  createMissionTrackingHandler: vi.fn(() => mockHandler),
}));

vi.mock("@/lib/skynet-config", () => ({
  config: {
    projectName: "test-project",
    devDir: "/tmp/test/.dev",
    lockPrefix: "/tmp/skynet-test-",
  },
}));

import { GET, dynamic } from "./route";
import { createMissionTrackingHandler } from "@ajioncorp/skynet/handlers";
import { config } from "@/lib/skynet-config";

const BASE_URL = "http://localhost/api/admin/mission/tracking";

describe("mission/tracking route wiring", () => {
  it("exports dynamic as force-dynamic", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  it("creates handler with the skynet config", () => {
    expect(createMissionTrackingHandler).toHaveBeenCalledWith(config);
  });

  it("exports GET as a function", () => {
    expect(typeof GET).toBe("function");
  });
});

describe("GET /api/admin/mission/tracking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delegates to handler and returns tracking data", async () => {
    const req = new Request(BASE_URL, { method: "GET" });
    const res = await GET(req);
    expect(mockHandler).toHaveBeenCalledTimes(1);
    expect(mockHandler).toHaveBeenCalledWith(req);
    const body = await res.json();
    expect(body.error).toBeNull();
    expect(body.data.slug).toBe("main");
    expect(body.data.trackingStatus).toBe("on-track");
    expect(body.data.assignedWorkers).toBe(2);
    expect(body.data.completionPercentage).toBe(50);
  });
});
