import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockPOST } = vi.hoisted(() => ({
  mockPOST: vi.fn(async () => Response.json({ data: { triggered: true, script: "watchdog" }, error: null })),
}));

vi.mock("@ajioncorp/skynet/handlers", () => ({
  createPipelineTriggerHandler: vi.fn(() => mockPOST),
}));

vi.mock("@/lib/skynet-config", () => ({
  config: {
    projectName: "test",
    devDir: "/tmp/test-dev",
    lockPrefix: "/tmp/skynet-test",
    workers: [],
    triggerableScripts: ["watchdog"],
    taskTags: [],
  },
}));

import { POST, dynamic } from "./route";
import { createPipelineTriggerHandler } from "@ajioncorp/skynet/handlers";

describe("POST /api/admin/pipeline/trigger", () => {
  beforeEach(() => {
    mockPOST.mockClear();
  });

  it("exports dynamic = 'force-dynamic'", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  it("exports a POST function", () => {
    expect(typeof POST).toBe("function");
  });

  it("wires createPipelineTriggerHandler with config at module load", () => {
    expect(createPipelineTriggerHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        projectName: "test",
        devDir: "/tmp/test-dev",
        lockPrefix: "/tmp/skynet-test",
        triggerableScripts: ["watchdog"],
      })
    );
  });

  it("delegates to the handler returned by the factory", async () => {
    const req = new Request("http://localhost/api/admin/pipeline/trigger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ script: "watchdog" }),
    });
    const res = await POST(req);
    expect(mockPOST).toHaveBeenCalledTimes(1);
    expect(mockPOST).toHaveBeenCalledWith(req);
    const body = await res.json();
    expect(body).toEqual({ data: { triggered: true, script: "watchdog" }, error: null });
  });
});
