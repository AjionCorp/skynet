import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGET = vi.hoisted(() =>
  vi.fn(async () =>
    Response.json({
      data: [
        {
          scriptName: "dev-worker",
          workerLabel: "Dev Worker",
          description: "Implements backlog tasks",
          category: "core",
          prompt: "You are a dev worker...",
        },
      ],
      error: null,
    }),
  ),
);

vi.mock("@ajioncorp/skynet/handlers", () => ({
  createPromptsHandler: vi.fn(() => mockGET),
}));

vi.mock("@/lib/skynet-config", () => ({
  config: {
    projectName: "test-project",
    devDir: "/tmp/test/.dev",
    lockPrefix: "/tmp/skynet-test-",
  },
}));

import { GET, dynamic } from "./route";
import { createPromptsHandler } from "@ajioncorp/skynet/handlers";
import { config } from "@/lib/skynet-config";

describe("prompts route wiring", () => {
  it("exports dynamic as force-dynamic", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  it("creates handler with the skynet config", () => {
    expect(createPromptsHandler).toHaveBeenCalledWith(config);
  });

  it("exports GET as a function", () => {
    expect(typeof GET).toBe("function");
  });
});

describe("GET /api/admin/prompts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delegates to handler and returns response", async () => {
    const res = await GET();
    expect(mockGET).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body.error).toBeNull();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].scriptName).toBe("dev-worker");
    expect(body.data[0].category).toBe("core");
  });
});
