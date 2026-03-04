import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGET } = vi.hoisted(() => ({
  mockGET: vi.fn(async () =>
    Response.json({
      data: { script: "dev-worker-1", lines: [], totalLines: 0, fileSizeBytes: 0, count: 200 },
      error: null,
    })
  ),
}));

vi.mock("@ajioncorp/skynet/handlers", () => ({
  createPipelineLogsHandler: vi.fn(() => mockGET),
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
import { createPipelineLogsHandler } from "@ajioncorp/skynet/handlers";

describe("GET /api/admin/pipeline/logs", () => {
  beforeEach(() => {
    mockGET.mockClear();
  });

  it("exports dynamic = 'force-dynamic'", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  it("exports a GET function", () => {
    expect(typeof GET).toBe("function");
  });

  it("wires createPipelineLogsHandler with config at module load", () => {
    expect(createPipelineLogsHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        projectName: "test",
        devDir: "/tmp/test-dev",
        lockPrefix: "/tmp/skynet-test",
      })
    );
  });

  it("delegates to the handler returned by the factory", async () => {
    const req = new Request("http://localhost/api/admin/pipeline/logs?script=dev-worker-1");
    const res = await GET(req);
    expect(mockGET).toHaveBeenCalledTimes(1);
    expect(mockGET).toHaveBeenCalledWith(req);
    const body = await res.json();
    expect(body).toEqual({
      data: { script: "dev-worker-1", lines: [], totalLines: 0, fileSizeBytes: 0, count: 200 },
      error: null,
    });
  });
});
