import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGET, mockPOST } = vi.hoisted(() => ({
  mockGET: vi.fn(async () =>
    Response.json({
      data: [
        { type: "dev-worker", label: "Dev Worker", count: 2, maxCount: 4, pids: [1001, 1002] },
        { type: "task-fixer", label: "Task Fixer", count: 1, maxCount: 2, pids: [2001] },
      ],
      error: null,
    }),
  ),
  mockPOST: vi.fn(async () =>
    Response.json({
      data: { workerType: "dev-worker", previousCount: 2, currentCount: 3, maxCount: 4 },
      error: null,
    }),
  ),
}));

vi.mock("@ajioncorp/skynet/handlers", () => ({
  createWorkerScalingHandler: vi.fn(() => ({ GET: mockGET, POST: mockPOST })),
}));

vi.mock("@/lib/skynet-config", () => ({
  config: {
    projectName: "test-project",
    devDir: "/tmp/test/.dev",
    lockPrefix: "/tmp/skynet-test-",
  },
}));

import { GET, POST, dynamic } from "./route";
import { createWorkerScalingHandler } from "@ajioncorp/skynet/handlers";
import { config } from "@/lib/skynet-config";

function makePostRequest(body: unknown): Request {
  return new Request("http://localhost/api/admin/workers/scale", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("workers/scale route wiring", () => {
  it("exports dynamic as force-dynamic", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  it("creates handler with the skynet config", () => {
    expect(createWorkerScalingHandler).toHaveBeenCalledWith(config);
  });

  it("exports GET as a function", () => {
    expect(typeof GET).toBe("function");
  });

  it("exports POST as a function", () => {
    expect(typeof POST).toBe("function");
  });
});

describe("GET /api/admin/workers/scale", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delegates to handler and returns response", async () => {
    const res = await GET();
    expect(mockGET).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body.error).toBeNull();
    expect(body.data).toHaveLength(2);
    expect(body.data[0].type).toBe("dev-worker");
    expect(body.data[1].type).toBe("task-fixer");
  });
});

describe("POST /api/admin/workers/scale", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delegates to handler with request", async () => {
    const req = makePostRequest({ workerType: "dev-worker", count: 3 });
    const res = await POST(req);
    expect(mockPOST).toHaveBeenCalledTimes(1);
    expect(mockPOST).toHaveBeenCalledWith(req);
    const body = await res.json();
    expect(body.data.workerType).toBe("dev-worker");
    expect(body.data.previousCount).toBe(2);
    expect(body.data.currentCount).toBe(3);
  });
});
