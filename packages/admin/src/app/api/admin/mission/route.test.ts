import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGET, mockPUT } = vi.hoisted(() => ({
  mockGET: vi.fn(async () =>
    Response.json({
      data: { raw: "# Main Mission\n\n## Purpose\nTest purpose" },
      error: null,
    }),
  ),
  mockPUT: vi.fn(async () =>
    Response.json({ data: { saved: true }, error: null }),
  ),
}));

vi.mock("@ajioncorp/skynet/handlers", () => ({
  createMissionRawHandler: vi.fn(() => ({ GET: mockGET, PUT: mockPUT })),
}));

vi.mock("@/lib/skynet-config", () => ({
  config: {
    projectName: "test-project",
    devDir: "/tmp/test/.dev",
    lockPrefix: "/tmp/skynet-test-",
  },
}));

import { GET, PUT, dynamic } from "./route";
import { createMissionRawHandler } from "@ajioncorp/skynet/handlers";
import { config } from "@/lib/skynet-config";

const BASE_URL = "http://localhost/api/admin/mission";

describe("mission route wiring", () => {
  it("exports dynamic as force-dynamic", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  it("creates handler with the skynet config", () => {
    expect(createMissionRawHandler).toHaveBeenCalledWith(config);
  });

  it("exports GET as a function", () => {
    expect(typeof GET).toBe("function");
  });

  it("exports PUT as a function", () => {
    expect(typeof PUT).toBe("function");
  });
});

describe("GET /api/admin/mission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delegates to handler and returns raw mission content", async () => {
    const res = await GET();
    expect(mockGET).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body.error).toBeNull();
    expect(body.data.raw).toContain("# Main Mission");
  });
});

describe("PUT /api/admin/mission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delegates to handler with request", async () => {
    const req = new Request(BASE_URL, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ raw: "# Updated Mission" }),
    });
    const res = await PUT(req);
    expect(mockPUT).toHaveBeenCalledTimes(1);
    expect(mockPUT).toHaveBeenCalledWith(req);
    const body = await res.json();
    expect(body.data.saved).toBe(true);
  });
});
