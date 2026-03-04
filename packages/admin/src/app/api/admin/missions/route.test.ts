import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGET, mockPOST } = vi.hoisted(() => ({
  mockGET: vi.fn(async () =>
    Response.json({
      data: { missions: [], config: { activeMission: "main", assignments: {} } },
      error: null,
    }),
  ),
  mockPOST: vi.fn(async () =>
    Response.json({ data: { slug: "new-mission", name: "New Mission" }, error: null }, { status: 201 }),
  ),
}));

vi.mock("@ajioncorp/skynet/handlers", () => ({
  createMissionsHandler: vi.fn(() => ({ GET: mockGET, POST: mockPOST })),
}));

vi.mock("@/lib/skynet-config", () => ({
  config: {
    projectName: "test-project",
    devDir: "/tmp/test/.dev",
    lockPrefix: "/tmp/skynet-test-",
  },
}));

import { GET, POST, dynamic } from "./route";
import { createMissionsHandler } from "@ajioncorp/skynet/handlers";
import { config } from "@/lib/skynet-config";

function makePostRequest(body: unknown): Request {
  return new Request("http://localhost/api/admin/missions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("missions route wiring", () => {
  it("exports dynamic as force-dynamic", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  it("creates handler with the skynet config", () => {
    expect(createMissionsHandler).toHaveBeenCalledWith(config);
  });

  it("exports GET as a function", () => {
    expect(typeof GET).toBe("function");
  });

  it("exports POST as a function", () => {
    expect(typeof POST).toBe("function");
  });
});

describe("GET /api/admin/missions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delegates to handler and returns response", async () => {
    const res = await GET();
    expect(mockGET).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body.error).toBeNull();
    expect(body.data.missions).toEqual([]);
    expect(body.data.config).toEqual({ activeMission: "main", assignments: {} });
  });
});

describe("POST /api/admin/missions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delegates to handler with request", async () => {
    const req = makePostRequest({ name: "New Mission" });
    const res = await POST(req);
    expect(mockPOST).toHaveBeenCalledTimes(1);
    expect(mockPOST).toHaveBeenCalledWith(req);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.slug).toBe("new-mission");
  });
});
