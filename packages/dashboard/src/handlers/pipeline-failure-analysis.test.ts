import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SkynetConfig } from "../types";

// ── Mocks ───────────────────────────────────────────────────────────

const mockGetFailedTasksWithWorker = vi.hoisted(() => vi.fn());
const mockGetSkynetDB = vi.hoisted(() => vi.fn());
const mockReadDevFile = vi.hoisted(() => vi.fn());

vi.mock("../lib/db", () => ({
  getSkynetDB: mockGetSkynetDB,
}));

vi.mock("../lib/file-reader", () => ({
  readDevFile: mockReadDevFile,
}));

vi.mock("../lib/handler-error", () => ({
  logHandlerError: vi.fn(),
}));

import { createPipelineFailureAnalysisHandler } from "./pipeline-failure-analysis";

// ── Helpers ─────────────────────────────────────────────────────────

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

function makeSqliteRow(overrides?: Record<string, unknown>) {
  return {
    date: "2026-03-01",
    task: "[FEAT] Add login",
    branch: "feat/login",
    error: "typecheck failure",
    attempts: 2,
    status: "fixed",
    workerId: 1,
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe("createPipelineFailureAnalysisHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: SQLite unavailable, empty file
    mockGetSkynetDB.mockImplementation(() => {
      throw new Error("SQLite not available");
    });
    mockReadDevFile.mockReturnValue("");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Basic response shape ────────────────────────────────────────

  it("returns 200 with empty analysis when no failed tasks exist", async () => {
    const GET = createPipelineFailureAnalysisHandler(makeConfig());
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error).toBeNull();
    expect(body.data).toEqual({
      summary: { total: 0, fixed: 0, blocked: 0, superseded: 0, pending: 0, selfCorrected: 0 },
      errorPatterns: [],
      timeline: [],
      byWorker: [],
      recentFailures: [],
    });
  });

  // ── SQLite path ─────────────────────────────────────────────────

  it("uses SQLite when available", async () => {
    mockGetSkynetDB.mockReturnValue({
      getFailedTasksWithWorker: mockGetFailedTasksWithWorker.mockReturnValue([
        makeSqliteRow(),
      ]),
    });

    const GET = createPipelineFailureAnalysisHandler(makeConfig());
    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.summary.total).toBe(1);
    expect(body.data.summary.fixed).toBe(1);
    expect(body.data.summary.selfCorrected).toBe(1);
    expect(mockGetSkynetDB).toHaveBeenCalledWith("/tmp/test/.dev", { readonly: true });
  });

  it("computes byWorker stats from SQLite rows", async () => {
    mockGetSkynetDB.mockReturnValue({
      getFailedTasksWithWorker: vi.fn(() => [
        makeSqliteRow({ workerId: 1, status: "fixed", attempts: 2 }),
        makeSqliteRow({ workerId: 1, status: "failed", attempts: 3, task: "[FIX] B" }),
        makeSqliteRow({ workerId: 2, status: "blocked", attempts: 1, task: "[FIX] C" }),
      ]),
    });

    const GET = createPipelineFailureAnalysisHandler(makeConfig());
    const body = await (await GET()).json();

    expect(body.data.byWorker).toHaveLength(2);
    const w1 = body.data.byWorker.find((w: { workerId: number }) => w.workerId === 1);
    expect(w1).toEqual({ workerId: 1, failures: 2, fixed: 1, avgAttempts: 2.5 });
  });

  // ── File fallback path ──────────────────────────────────────────

  it("falls back to file-based parsing when SQLite throws", async () => {
    mockReadDevFile.mockImplementation((_dir: string, filename: string) => {
      if (filename === "failed-tasks.md") {
        return [
          "| Date | Task | Branch | Error | Details | Attempts | Status |",
          "| --- | --- | --- | --- | --- | --- | --- |",
          "| 2026-03-01 | [FEAT] Login | feat/login | merge conflict | n/a | 2 | fixed |",
          "| 2026-03-02 | [FIX] Bug | fix/bug | timeout | n/a | 1 | blocked |",
        ].join("\n");
      }
      return "";
    });

    const GET = createPipelineFailureAnalysisHandler(makeConfig());
    const body = await (await GET()).json();

    expect(body.data.summary.total).toBe(2);
    expect(body.data.summary.fixed).toBe(1);
    expect(body.data.summary.blocked).toBe(1);
    // File-based tasks have null workerId, so byWorker is empty
    expect(body.data.byWorker).toHaveLength(0);
  });

  // ── Error pattern classification ────────────────────────────────

  it("classifies known error patterns correctly", async () => {
    mockGetSkynetDB.mockReturnValue({
      getFailedTasksWithWorker: vi.fn(() => [
        makeSqliteRow({ error: "merge conflict in file.ts", task: "T1" }),
        makeSqliteRow({ error: "typecheck failure: 3 errors", task: "T2" }),
        makeSqliteRow({ error: "usage limits exceeded", task: "T3" }),
        makeSqliteRow({ error: "claude exit code 1", task: "T4" }),
        makeSqliteRow({ error: "timeout after 300s", task: "T5" }),
        makeSqliteRow({ error: "something weird", task: "T6" }),
      ]),
    });

    const GET = createPipelineFailureAnalysisHandler(makeConfig());
    const body = await (await GET()).json();
    const patterns = body.data.errorPatterns as Array<{ pattern: string; count: number }>;

    const patternNames = patterns.map((p) => p.pattern);
    expect(patternNames).toContain("merge conflict");
    expect(patternNames).toContain("typecheck failure");
    expect(patternNames).toContain("usage limits");
    expect(patternNames).toContain("claude exit code");
    expect(patternNames).toContain("timeout");
    expect(patternNames).toContain("other");
  });

  it("classifies empty error as unknown", async () => {
    mockGetSkynetDB.mockReturnValue({
      getFailedTasksWithWorker: vi.fn(() => [
        makeSqliteRow({ error: "" }),
      ]),
    });

    const GET = createPipelineFailureAnalysisHandler(makeConfig());
    const body = await (await GET()).json();

    expect(body.data.errorPatterns[0].pattern).toBe("unknown");
  });

  // ── Timeline ────────────────────────────────────────────────────

  it("builds timeline sorted by date", async () => {
    mockGetSkynetDB.mockReturnValue({
      getFailedTasksWithWorker: vi.fn(() => [
        makeSqliteRow({ date: "2026-03-02", status: "blocked", task: "T1" }),
        makeSqliteRow({ date: "2026-03-01", status: "fixed", task: "T2" }),
        makeSqliteRow({ date: "2026-03-01", status: "failed", task: "T3" }),
      ]),
    });

    const GET = createPipelineFailureAnalysisHandler(makeConfig());
    const body = await (await GET()).json();
    const tl = body.data.timeline;

    expect(tl).toHaveLength(2);
    expect(tl[0].date).toBe("2026-03-01");
    expect(tl[0].failures).toBe(2);
    expect(tl[0].fixed).toBe(1);
    expect(tl[1].date).toBe("2026-03-02");
    expect(tl[1].blocked).toBe(1);
  });

  // ── Recent failures ─────────────────────────────────────────────

  it("returns only pending/fixing tasks in recentFailures", async () => {
    mockGetSkynetDB.mockReturnValue({
      getFailedTasksWithWorker: vi.fn(() => [
        makeSqliteRow({ status: "fixed", task: "T1" }),
        makeSqliteRow({ status: "failed", task: "T2" }),
        makeSqliteRow({ status: "fixing-w1", task: "T3" }),
        makeSqliteRow({ status: "blocked", task: "T4" }),
      ]),
    });

    const GET = createPipelineFailureAnalysisHandler(makeConfig());
    const body = await (await GET()).json();
    const recent = body.data.recentFailures;

    expect(recent).toHaveLength(2);
    const tasks = recent.map((r: { task: string }) => r.task);
    expect(tasks).toContain("T2");
    expect(tasks).toContain("T3");
  });

  // ── Summary counts ──────────────────────────────────────────────

  it("counts superseded and pending statuses correctly", async () => {
    mockGetSkynetDB.mockReturnValue({
      getFailedTasksWithWorker: vi.fn(() => [
        makeSqliteRow({ status: "superseded", task: "T1" }),
        makeSqliteRow({ status: "superseded", task: "T2" }),
        makeSqliteRow({ status: "fixing-w2", task: "T3" }),
      ]),
    });

    const GET = createPipelineFailureAnalysisHandler(makeConfig());
    const body = await (await GET()).json();

    expect(body.data.summary.superseded).toBe(2);
    expect(body.data.summary.pending).toBe(1);
    expect(body.data.summary.selfCorrected).toBe(2); // fixed + superseded
  });

  // ── 500 error path ──────────────────────────────────────────────

  it("returns 500 when both SQLite and file parsing fail", async () => {
    // SQLite throws (default mock), then file parsing also throws
    mockReadDevFile.mockImplementation(() => {
      throw new Error("disk failure");
    });

    const GET = createPipelineFailureAnalysisHandler(makeConfig());
    const res = await GET();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.data).toBeNull();
    expect(body.error).toBeTruthy();
  });
});
