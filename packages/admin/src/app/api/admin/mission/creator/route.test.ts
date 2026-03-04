import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockPOST } = vi.hoisted(() => ({
  mockPOST: vi.fn(async () =>
    Response.json({
      data: {
        mission: "# New Mission\n\n## Purpose\nGenerated",
        suggestions: [
          { title: "Suggestion 1", content: "Detail 1" },
          { title: "Suggestion 2", content: "Detail 2" },
          { title: "Suggestion 3", content: "Detail 3" },
        ],
      },
      error: null,
    }),
  ),
}));

vi.mock("@ajioncorp/skynet/handlers", () => ({
  createMissionCreatorHandler: vi.fn(() => ({
    POST: mockPOST,
    expand: vi.fn(),
  })),
}));

vi.mock("@/lib/skynet-config", () => ({
  config: {
    projectName: "test-project",
    devDir: "/tmp/test/.dev",
    lockPrefix: "/tmp/skynet-test-",
  },
}));

import { POST, dynamic } from "./route";
import { createMissionCreatorHandler } from "@ajioncorp/skynet/handlers";
import { config } from "@/lib/skynet-config";

const BASE_URL = "http://localhost/api/admin/mission/creator";

describe("mission/creator route wiring", () => {
  it("exports dynamic as force-dynamic", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  it("creates handler with the skynet config", () => {
    expect(createMissionCreatorHandler).toHaveBeenCalledWith(config);
  });

  it("exports POST as a function", () => {
    expect(typeof POST).toBe("function");
  });
});

describe("POST /api/admin/mission/creator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delegates to handler with request", async () => {
    const req = new Request(BASE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "Build an e-commerce platform" }),
    });
    const res = await POST(req);
    expect(mockPOST).toHaveBeenCalledTimes(1);
    expect(mockPOST).toHaveBeenCalledWith(req);
    const body = await res.json();
    expect(body.error).toBeNull();
    expect(body.data.mission).toContain("# New Mission");
    expect(body.data.suggestions).toHaveLength(3);
  });
});
