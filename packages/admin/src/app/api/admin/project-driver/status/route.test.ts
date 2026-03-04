import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGET = vi.hoisted(() =>
  vi.fn(async () =>
    Response.json({
      data: {
        running: true,
        pid: 12345,
        ageMs: 60000,
        lastLog: "Processing backlog",
        lastLogTime: "2026-03-03T10:00:00Z",
        telemetry: {
          pendingBacklog: 3,
          claimedBacklog: 1,
          pendingRetries: 0,
          fixRate: 0.75,
          duplicateSkipped: 2,
          maxNewTasks: 5,
          driver_low_fix_rate_mode: false,
          ts: "2026-03-03T10:00:00Z",
        },
      },
      error: null,
    }),
  ),
);

vi.mock("@ajioncorp/skynet/handlers", () => ({
  createProjectDriverStatusHandler: vi.fn(() => mockGET),
}));

vi.mock("@/lib/skynet-config", () => ({
  config: {
    projectName: "test-project",
    devDir: "/tmp/test/.dev",
    lockPrefix: "/tmp/skynet-test-",
  },
}));

import { GET, dynamic } from "./route";
import { createProjectDriverStatusHandler } from "@ajioncorp/skynet/handlers";
import { config } from "@/lib/skynet-config";

describe("project-driver status route wiring", () => {
  it("exports dynamic as force-dynamic", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  it("creates handler with the skynet config", () => {
    expect(createProjectDriverStatusHandler).toHaveBeenCalledWith(config);
  });

  it("exports GET as a function", () => {
    expect(typeof GET).toBe("function");
  });
});

describe("GET /api/admin/project-driver/status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delegates to handler and returns response", async () => {
    const res = await GET();
    expect(mockGET).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body.error).toBeNull();
    expect(body.data.running).toBe(true);
    expect(body.data.pid).toBe(12345);
    expect(body.data.telemetry).toBeDefined();
    expect(body.data.telemetry.pendingBacklog).toBe(3);
  });
});
