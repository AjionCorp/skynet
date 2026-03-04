import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock all dependencies used by the pipeline-status handler
vi.mock("fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ""),
  statSync: vi.fn(() => ({ mtimeMs: Date.now(), ino: 1, size: 0 })),
  readdirSync: vi.fn(() => []),
  appendFileSync: vi.fn(),
  renameSync: vi.fn(),
}));
vi.mock("child_process", () => ({
  execSync: vi.fn(() => ""),
  spawnSync: vi.fn(() => ({ stdout: "", stderr: "", status: 0 })),
}));

// Provide controlled config
vi.mock("../../../../../lib/skynet-config", () => ({
  config: {
    projectName: "test-project",
    devDir: "/tmp/test/.dev",
    lockPrefix: "/tmp/skynet-test",
    workers: [
      { name: "dev-worker-1", label: "Dev Worker 1", category: "core", schedule: "On demand", description: "Implements tasks" },
    ],
    triggerableScripts: [],
    taskTags: ["FEAT", "FIX"],
  },
}));

import { GET, dynamic } from "./route";

describe("/api/admin/monitoring/status route integration", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.NODE_ENV = "development";
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it("exports force-dynamic to disable Next.js response caching", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  it("returns { data, error: null } envelope on success", async () => {
    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toHaveProperty("data");
    expect(body).toHaveProperty("error");
    expect(body.error).toBeNull();
  });

  it("includes expected top-level keys matching PipelineStatus", async () => {
    const res = await GET();
    const { data } = await res.json();

    expect(data).toHaveProperty("workers");
    expect(data).toHaveProperty("currentTask");
    expect(data).toHaveProperty("backlog");
    expect(data).toHaveProperty("completed");
    expect(data).toHaveProperty("failed");
    expect(data).toHaveProperty("hasBlockers");
    expect(data).toHaveProperty("syncHealth");
    expect(data).toHaveProperty("auth");
    expect(data).toHaveProperty("git");
    expect(data).toHaveProperty("timestamp");
  });

  it("reflects workers from config in response", async () => {
    const res = await GET();
    const { data } = await res.json();

    expect(data.workers).toHaveLength(1);
    expect(data.workers[0].name).toBe("dev-worker-1");
  });

  it("returns ISO timestamp in response", async () => {
    const res = await GET();
    const { data } = await res.json();

    expect(data.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("returns health score as a number", async () => {
    const res = await GET();
    const { data } = await res.json();

    expect(typeof data.healthScore).toBe("number");
    expect(data.healthScore).toBeGreaterThanOrEqual(0);
    expect(data.healthScore).toBeLessThanOrEqual(100);
  });
});
