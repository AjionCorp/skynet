import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockExpand } = vi.hoisted(() => ({
  mockExpand: vi.fn(async () =>
    Response.json({
      data: {
        suggestions: [
          { title: "Sub 1", content: "Sub-detail 1" },
          { title: "Sub 2", content: "Sub-detail 2" },
          { title: "Sub 3", content: "Sub-detail 3" },
        ],
      },
      error: null,
    }),
  ),
}));

vi.mock("@ajioncorp/skynet/handlers", () => ({
  createMissionCreatorHandler: vi.fn(() => ({
    POST: vi.fn(),
    expand: mockExpand,
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

const BASE_URL = "http://localhost/api/admin/mission/creator/expand";

describe("mission/creator/expand route wiring", () => {
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

describe("POST /api/admin/mission/creator/expand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delegates to handler expand and returns sub-suggestions", async () => {
    const req = new Request(BASE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ suggestion: "Add user auth", currentMission: "# Existing" }),
    });
    const res = await POST(req);
    expect(mockExpand).toHaveBeenCalledTimes(1);
    expect(mockExpand).toHaveBeenCalledWith(req);
    const body = await res.json();
    expect(body.error).toBeNull();
    expect(body.data.suggestions).toHaveLength(3);
    expect(body.data.suggestions[0].title).toBe("Sub 1");
  });
});
