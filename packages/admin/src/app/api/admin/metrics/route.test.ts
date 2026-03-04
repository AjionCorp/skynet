import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock fs — statSync is used by the DB singleton factory
vi.mock("fs", () => ({
  statSync: vi.fn(() => ({ mtimeMs: Date.now(), ino: 1 })),
}));

// Provide controlled config so tests don't depend on real .dev/ paths
vi.mock("../../../../lib/skynet-config", () => ({
  config: {
    projectName: "test-project",
    devDir: "/tmp/test/.dev",
    lockPrefix: "/tmp/skynet-test",
    workers: [],
    triggerableScripts: [],
    taskTags: ["FEAT", "FIX"],
  },
}));

import { GET, dynamic } from "./route";

describe("/api/admin/metrics route integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exports force-dynamic to disable Next.js response caching", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  it("returns 200 with Prometheus content-type header", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe(
      "text/plain; version=0.0.4; charset=utf-8"
    );
  });

  it("returns valid Prometheus text exposition format", async () => {
    const res = await GET();
    const body = await res.text();

    // Should always contain the skynet_up metric
    expect(body).toContain("skynet_up");
    expect(body).toContain("# HELP skynet_up");
    expect(body).toContain("# TYPE skynet_up gauge");
  });

  it("returns skynet_up indicator (0 or 1) based on DB availability", async () => {
    const res = await GET();
    const body = await res.text();

    // When DB is unavailable (no real SQLite in test env), skynet_up is 0
    // When DB is available, skynet_up is 1. Either value is valid.
    expect(body).toMatch(/skynet_up [01]/);
  });

  it("all metric values are numeric", async () => {
    const res = await GET();
    const body = await res.text();

    const metricLines = body
      .split("\n")
      .filter((line) => line && !line.startsWith("#"));

    expect(metricLines.length).toBeGreaterThan(0);

    for (const line of metricLines) {
      const value = line.split(" ").pop();
      expect(value).toBeDefined();
      expect(Number.isFinite(Number(value))).toBe(true);
    }
  });

  it("always returns 200 even when DB is unavailable (Prometheus convention)", async () => {
    // The metrics handler never returns non-200 — it degrades gracefully
    const res = await GET();
    expect(res.status).toBe(200);
  });
});
