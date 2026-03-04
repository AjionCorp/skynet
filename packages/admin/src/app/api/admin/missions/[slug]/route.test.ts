import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGET, mockPUT, mockDELETE } = vi.hoisted(() => ({
  mockGET: vi.fn(async () =>
    Response.json({
      data: {
        slug: "my-mission",
        raw: "# My Mission\n\n## Purpose\nTest",
        isActive: true,
        assignedWorkers: ["dev-worker-1"],
        llmConfig: { provider: "auto" },
      },
      error: null,
    }),
  ),
  mockPUT: vi.fn(async () =>
    Response.json({ data: { slug: "my-mission", saved: true }, error: null }),
  ),
  mockDELETE: vi.fn(async () =>
    Response.json({ data: { slug: "old-mission", deleted: true }, error: null }),
  ),
}));

vi.mock("@ajioncorp/skynet/handlers", () => ({
  createMissionDetailHandler: vi.fn(() => ({
    GET: mockGET,
    PUT: mockPUT,
    DELETE: mockDELETE,
  })),
}));

vi.mock("@/lib/skynet-config", () => ({
  config: {
    projectName: "test-project",
    devDir: "/tmp/test/.dev",
    lockPrefix: "/tmp/skynet-test-",
  },
}));

import { GET, PUT, DELETE, dynamic } from "./route";
import { createMissionDetailHandler } from "@ajioncorp/skynet/handlers";
import { config } from "@/lib/skynet-config";

const BASE_URL = "http://localhost/api/admin/missions";

function makeGetRequest(slug: string): Request {
  return new Request(`${BASE_URL}/${slug}`, { method: "GET" });
}

function makePutRequest(slug: string, body: Record<string, unknown>): Request {
  return new Request(`${BASE_URL}/${slug}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeDeleteRequest(slug: string): Request {
  return new Request(`${BASE_URL}/${slug}`, { method: "DELETE" });
}

describe("missions/[slug] route wiring", () => {
  it("exports dynamic as force-dynamic", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  it("creates handler with the skynet config", () => {
    expect(createMissionDetailHandler).toHaveBeenCalledWith(config);
  });

  it("exports GET as a function", () => {
    expect(typeof GET).toBe("function");
  });

  it("exports PUT as a function", () => {
    expect(typeof PUT).toBe("function");
  });

  it("exports DELETE as a function", () => {
    expect(typeof DELETE).toBe("function");
  });
});

describe("GET /api/admin/missions/[slug]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delegates to handler and returns mission detail", async () => {
    const req = makeGetRequest("my-mission");
    const res = await GET(req);
    expect(mockGET).toHaveBeenCalledTimes(1);
    expect(mockGET).toHaveBeenCalledWith(req);
    const body = await res.json();
    expect(body.error).toBeNull();
    expect(body.data.slug).toBe("my-mission");
    expect(body.data.raw).toContain("# My Mission");
    expect(body.data.isActive).toBe(true);
    expect(body.data.assignedWorkers).toEqual(["dev-worker-1"]);
  });
});

describe("PUT /api/admin/missions/[slug]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delegates to handler with request", async () => {
    const req = makePutRequest("my-mission", { raw: "# Updated Content" });
    const res = await PUT(req);
    expect(mockPUT).toHaveBeenCalledTimes(1);
    expect(mockPUT).toHaveBeenCalledWith(req);
    const body = await res.json();
    expect(body.data.slug).toBe("my-mission");
    expect(body.data.saved).toBe(true);
  });
});

describe("DELETE /api/admin/missions/[slug]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delegates to handler with request", async () => {
    const req = makeDeleteRequest("old-mission");
    const res = await DELETE(req);
    expect(mockDELETE).toHaveBeenCalledTimes(1);
    expect(mockDELETE).toHaveBeenCalledWith(req);
    const body = await res.json();
    expect(body.data.slug).toBe("old-mission");
    expect(body.data.deleted).toBe(true);
  });
});
