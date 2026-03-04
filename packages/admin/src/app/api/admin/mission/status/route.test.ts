import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockHandler } = vi.hoisted(() => ({
  mockHandler: vi.fn(async () =>
    Response.json({
      data: {
        purpose: "Test purpose",
        goals: [{ text: "Goal 1", completed: false }],
        successCriteria: [{ text: "Criterion 1", completed: true }],
        currentFocus: "Testing",
        completionPercentage: 50,
        raw: "# Mission\n\n## Purpose\nTest purpose",
      },
      error: null,
    }),
  ),
}));

vi.mock("@ajioncorp/skynet/handlers", () => ({
  createMissionStatusHandler: vi.fn(() => mockHandler),
}));

vi.mock("@/lib/skynet-config", () => ({
  config: {
    projectName: "test-project",
    devDir: "/tmp/test/.dev",
    lockPrefix: "/tmp/skynet-test-",
  },
}));

import { GET, dynamic } from "./route";
import { createMissionStatusHandler } from "@ajioncorp/skynet/handlers";
import { config } from "@/lib/skynet-config";

const BASE_URL = "http://localhost/api/admin/mission/status";

describe("mission/status route wiring", () => {
  it("exports dynamic as force-dynamic", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  it("creates handler with the skynet config", () => {
    expect(createMissionStatusHandler).toHaveBeenCalledWith(config);
  });

  it("exports GET as a function", () => {
    expect(typeof GET).toBe("function");
  });
});

describe("GET /api/admin/mission/status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delegates to handler and returns mission status", async () => {
    const req = new Request(BASE_URL, { method: "GET" });
    const res = await GET(req);
    expect(mockHandler).toHaveBeenCalledTimes(1);
    expect(mockHandler).toHaveBeenCalledWith(req);
    const body = await res.json();
    expect(body.error).toBeNull();
    expect(body.data.purpose).toBe("Test purpose");
    expect(body.data.goals).toHaveLength(1);
    expect(body.data.successCriteria).toHaveLength(1);
    expect(body.data.completionPercentage).toBe(50);
  });
});
