import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGET } = vi.hoisted(() => ({
  mockGET: vi.fn(async () => Response.json({ data: [], error: null })),
}));

vi.mock("@ajioncorp/skynet/handlers", () => ({
  createPipelineFailureAnalysisHandler: vi.fn(() => mockGET),
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

import { GET, dynamic } from "./route";
import { createPipelineFailureAnalysisHandler } from "@ajioncorp/skynet/handlers";

describe("GET /api/admin/pipeline/failure-analysis", () => {
  beforeEach(() => {
    mockGET.mockClear();
  });

  it("exports dynamic = 'force-dynamic'", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  it("exports a GET function", () => {
    expect(typeof GET).toBe("function");
  });

  it("wires createPipelineFailureAnalysisHandler with config at module load", () => {
    expect(createPipelineFailureAnalysisHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        projectName: "test",
        devDir: "/tmp/test-dev",
        lockPrefix: "/tmp/skynet-test",
      })
    );
  });

  it("delegates to the handler returned by the factory", async () => {
    const res = await GET();
    expect(mockGET).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body).toEqual({ data: [], error: null });
  });

  it("passes request through to the handler", async () => {
    const req = new Request("http://localhost/api/admin/pipeline/failure-analysis");
    await GET(req);
    expect(mockGET).toHaveBeenCalledWith(req);
  });
});
