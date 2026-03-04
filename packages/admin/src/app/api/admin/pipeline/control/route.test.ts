import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockPOST } = vi.hoisted(() => ({
  mockPOST: vi.fn(async () => Response.json({ data: { paused: true }, error: null })),
}));

vi.mock("@ajioncorp/skynet/handlers", () => ({
  createPipelineControlHandler: vi.fn(() => ({ POST: mockPOST })),
}));

vi.mock("@/lib/skynet-config", () => ({
  config: {
    projectName: "test",
    devDir: "/tmp/test-dev",
    lockPrefix: "/tmp/skynet-test",
    workers: [],
    triggerableScripts: [],
    taskTags: [],
  },
}));

import { POST, dynamic } from "./route";
import { createPipelineControlHandler } from "@ajioncorp/skynet/handlers";

describe("POST /api/admin/pipeline/control", () => {
  beforeEach(() => {
    mockPOST.mockClear();
  });

  it("exports dynamic = 'force-dynamic'", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  it("exports a POST function", () => {
    expect(typeof POST).toBe("function");
  });

  it("wires createPipelineControlHandler with config at module load", () => {
    expect(createPipelineControlHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        projectName: "test",
        devDir: "/tmp/test-dev",
        lockPrefix: "/tmp/skynet-test",
      })
    );
  });

  it("delegates to the handler.POST returned by the factory", async () => {
    const req = new Request("http://localhost/api/admin/pipeline/control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "pause" }),
    });
    const res = await POST(req);
    expect(mockPOST).toHaveBeenCalledTimes(1);
    expect(mockPOST).toHaveBeenCalledWith(req);
    const body = await res.json();
    expect(body).toEqual({ data: { paused: true }, error: null });
  });
});
