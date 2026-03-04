import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGET, mockPOST } = vi.hoisted(() => ({
  mockGET: vi.fn(async () =>
    Response.json({
      data: { state: "ACTIVE" },
      error: null,
    }),
  ),
  mockPOST: vi.fn(async () =>
    Response.json({ data: { state: "PAUSED" }, error: null }),
  ),
}));

vi.mock("@ajioncorp/skynet/handlers", () => ({
  createMissionStateHandler: vi.fn(() => ({ GET: mockGET, POST: mockPOST })),
}));

vi.mock("@/lib/skynet-config", () => ({
  config: {
    projectName: "test-project",
    devDir: "/tmp/test/.dev",
    lockPrefix: "/tmp/skynet-test-",
  },
}));

import { GET, POST, dynamic } from "./route";
import { createMissionStateHandler } from "@ajioncorp/skynet/handlers";
import { config } from "@/lib/skynet-config";

const BASE_URL = "http://localhost/api/admin/mission/state";

describe("mission/state route wiring", () => {
  it("exports dynamic as force-dynamic", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  it("creates handler with the skynet config", () => {
    expect(createMissionStateHandler).toHaveBeenCalledWith(config);
  });

  it("exports GET as a function", () => {
    expect(typeof GET).toBe("function");
  });

  it("exports POST as a function", () => {
    expect(typeof POST).toBe("function");
  });
});

describe("GET /api/admin/mission/state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delegates to handler and returns mission state", async () => {
    const req = new Request(BASE_URL, { method: "GET" });
    const res = await GET(req);
    expect(mockGET).toHaveBeenCalledTimes(1);
    expect(mockGET).toHaveBeenCalledWith(req);
    const body = await res.json();
    expect(body.error).toBeNull();
    expect(body.data.state).toBe("ACTIVE");
  });
});

describe("POST /api/admin/mission/state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delegates to handler with request", async () => {
    const req = new Request(BASE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: "PAUSED" }),
    });
    const res = await POST(req);
    expect(mockPOST).toHaveBeenCalledTimes(1);
    expect(mockPOST).toHaveBeenCalledWith(req);
    const body = await res.json();
    expect(body.data.state).toBe("PAUSED");
    expect(body.error).toBeNull();
  });
});
