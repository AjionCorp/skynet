import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SkynetConfig } from "../types";

// vi.hoisted runs before vi.mock hoisting — safe to reference in factory
const mockBuffer = vi.hoisted(() => [] as { ts: number; score: number }[]);

vi.mock("./pipeline-status", () => ({
  healthTrendBuffer: mockBuffer,
}));

import { createPipelineHealthTrendHandler } from "./pipeline-health-trend";

function makeConfig(overrides?: Partial<SkynetConfig>): SkynetConfig {
  return {
    projectName: "test-project",
    devDir: "/tmp/test/.dev",
    lockPrefix: "/tmp/skynet-test-",
    workers: [],
    triggerableScripts: [],
    taskTags: ["FEAT", "FIX", "INFRA", "TEST", "NMI"],
    ...overrides,
  };
}

describe("createPipelineHealthTrendHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBuffer.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 200 with JSON content-type", async () => {
    const GET = createPipelineHealthTrendHandler(makeConfig());
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
  });

  it("returns empty array when no health data recorded", async () => {
    const GET = createPipelineHealthTrendHandler(makeConfig());
    const res = await GET();
    const body = await res.json();
    expect(body).toEqual({ data: [], error: null });
  });

  it("returns buffer entries when health data exists", async () => {
    mockBuffer.push({ ts: 1000, score: 80 });
    mockBuffer.push({ ts: 2000, score: 90 });

    const GET = createPipelineHealthTrendHandler(makeConfig());
    const res = await GET();
    const body = await res.json();
    expect(body.error).toBeNull();
    expect(body.data).toHaveLength(2);
    expect(body.data[0]).toEqual({ ts: 1000, score: 80 });
    expect(body.data[1]).toEqual({ ts: 2000, score: 90 });
  });

  it("returns the same buffer reference across calls", async () => {
    const GET = createPipelineHealthTrendHandler(makeConfig());

    // First call — empty
    const res1 = await GET();
    const body1 = await res1.json();
    expect(body1.data).toHaveLength(0);

    // Push data between calls
    mockBuffer.push({ ts: 3000, score: 75 });

    // Second call — reflects new data
    const res2 = await GET();
    const body2 = await res2.json();
    expect(body2.data).toHaveLength(1);
    expect(body2.data[0].score).toBe(75);
  });

  it("ignores config (handler is config-independent)", async () => {
    mockBuffer.push({ ts: 5000, score: 100 });

    const GET = createPipelineHealthTrendHandler(
      makeConfig({ projectName: "other-project", devDir: "/other/dir" })
    );
    const res = await GET();
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].score).toBe(100);
  });
});
