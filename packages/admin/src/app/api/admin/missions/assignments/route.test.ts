import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGET, mockPUT } = vi.hoisted(() => ({
  mockGET: vi.fn(async () =>
    Response.json({
      data: { activeMission: "main", assignments: {} },
      error: null,
    }),
  ),
  mockPUT: vi.fn(async () =>
    Response.json({
      data: { activeMission: "feature-x", assignments: { "dev-worker-1": "feature-x" } },
      error: null,
    }),
  ),
}));

vi.mock("@ajioncorp/skynet/handlers", () => ({
  createMissionAssignmentsHandler: vi.fn(() => ({ GET: mockGET, PUT: mockPUT })),
}));

vi.mock("@/lib/skynet-config", () => ({
  config: {
    projectName: "test-project",
    devDir: "/tmp/test/.dev",
    lockPrefix: "/tmp/skynet-test-",
  },
}));

import { GET, PUT, dynamic } from "./route";
import { createMissionAssignmentsHandler } from "@ajioncorp/skynet/handlers";
import { config } from "@/lib/skynet-config";

function makePutRequest(body: unknown): Request {
  return new Request("http://localhost/api/admin/missions/assignments", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("assignments route wiring", () => {
  it("exports dynamic as force-dynamic", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  it("creates handler with the skynet config", () => {
    expect(createMissionAssignmentsHandler).toHaveBeenCalledWith(config);
  });

  it("exports GET as a function", () => {
    expect(typeof GET).toBe("function");
  });

  it("exports PUT as a function", () => {
    expect(typeof PUT).toBe("function");
  });
});

describe("GET /api/admin/missions/assignments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delegates to handler and returns assignment config", async () => {
    const res = await GET();
    expect(mockGET).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body.error).toBeNull();
    expect(body.data.activeMission).toBe("main");
    expect(body.data.assignments).toEqual({});
  });
});

describe("PUT /api/admin/missions/assignments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("PUT delegates to handler with request", async () => {
    const req = makePutRequest({
      activeMission: "feature-x",
      assignments: { "dev-worker-1": "feature-x" },
    });
    const res = await PUT(req);
    expect(mockPUT).toHaveBeenCalledTimes(1);
    expect(mockPUT).toHaveBeenCalledWith(req);
    const body = await res.json();
    expect(body.data.activeMission).toBe("feature-x");
    expect(body.data.assignments["dev-worker-1"]).toBe("feature-x");
  });
});
