import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGET } = vi.hoisted(() => ({
  mockGET: vi.fn(async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: {}\n\n"));
        controller.close();
      },
    });
    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream" },
    });
  }),
}));

vi.mock("@ajioncorp/skynet/handlers", () => ({
  createPipelineStreamHandler: vi.fn(() => mockGET),
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
import { createPipelineStreamHandler } from "@ajioncorp/skynet/handlers";

describe("GET /api/admin/pipeline/stream", () => {
  beforeEach(() => {
    mockGET.mockClear();
  });

  it("exports dynamic = 'force-dynamic'", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  it("exports a GET function", () => {
    expect(typeof GET).toBe("function");
  });

  it("wires createPipelineStreamHandler with config at module load", () => {
    expect(createPipelineStreamHandler).toHaveBeenCalledWith(
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
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
  });

  it("passes request through to the handler", async () => {
    const req = new Request("http://localhost/api/admin/pipeline/stream");
    await GET(req);
    expect(mockGET).toHaveBeenCalledWith(req);
  });
});
