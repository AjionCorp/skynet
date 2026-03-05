import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SkynetConfig } from "../types";

// ── Mocks ───────────────────────────────────────────────────────────

const mockGetWorkerIntents = vi.hoisted(() => vi.fn());
const mockGetSkynetDB = vi.hoisted(() => vi.fn());

vi.mock("../lib/db", () => ({
  getSkynetDB: mockGetSkynetDB,
}));

vi.mock("../lib/handler-error", () => ({
  logHandlerError: vi.fn(),
}));

import { createWorkerIntentsHandler } from "./worker-intents";

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

function makeDbRow(overrides?: Record<string, unknown>) {
  return {
    workerId: 1,
    workerType: "dev",
    status: "idle",
    taskId: null,
    taskTitle: null,
    branch: null,
    startedAt: null,
    heartbeatEpoch: null,
    progressEpoch: null,
    lastInfo: null,
    updatedAt: "2026-03-05T10:00:00Z",
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe("createWorkerIntentsHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-05T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ── Basic response shape ────────────────────────────────────────

  it("returns 200 with empty intents when no workers exist", async () => {
    mockGetSkynetDB.mockReturnValue({
      getWorkerIntents: mockGetWorkerIntents.mockReturnValue([]),
    });

    const { GET } = createWorkerIntentsHandler(makeConfig());
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error).toBeNull();
    expect(body.data).toEqual({ intents: [] });
  });

  it("calls getSkynetDB with correct devDir and readonly", async () => {
    mockGetSkynetDB.mockReturnValue({
      getWorkerIntents: mockGetWorkerIntents.mockReturnValue([]),
    });

    const { GET } = createWorkerIntentsHandler(makeConfig());
    await GET();

    expect(mockGetSkynetDB).toHaveBeenCalledWith("/tmp/test/.dev", { readonly: true });
  });

  // ── Intent mapping ───────────────────────────────────────────────

  it("maps db rows to WorkerIntent shape", async () => {
    mockGetSkynetDB.mockReturnValue({
      getWorkerIntents: vi.fn(() => [
        makeDbRow({
          workerId: 1,
          workerType: "dev",
          status: "working",
          taskId: 42,
          taskTitle: "[FEAT] Add login",
          branch: "feat/login",
          startedAt: "2026-03-05T11:00:00Z",
          heartbeatEpoch: 1741348800, // 2026-03-05T12:00:00Z in epoch seconds
          progressEpoch: 1741348790,
          lastInfo: "Running typecheck",
          updatedAt: "2026-03-05T11:30:00Z",
        }),
      ]),
    });

    const { GET } = createWorkerIntentsHandler(makeConfig());
    const body = await (await GET()).json();

    expect(body.data.intents).toHaveLength(1);
    const intent = body.data.intents[0];
    expect(intent.workerId).toBe(1);
    expect(intent.workerType).toBe("dev");
    expect(intent.status).toBe("working");
    expect(intent.taskId).toBe(42);
    expect(intent.taskTitle).toBe("[FEAT] Add login");
    expect(intent.branch).toBe("feat/login");
    expect(intent.startedAt).toBe("2026-03-05T11:00:00Z");
    expect(intent.lastHeartbeat).toBe(1741348800);
    expect(intent.lastProgress).toBe(1741348790);
    expect(intent.lastInfo).toBe("Running typecheck");
    expect(intent.updatedAt).toBe("2026-03-05T11:30:00Z");
  });

  // ── Heartbeat / progress age computation ─────────────────────────

  it("computes heartbeatAgeMs from epoch seconds", async () => {
    const nowMs = Date.now(); // 2026-03-05T12:00:00Z
    const heartbeatEpoch = nowMs / 1000 - 30; // 30 seconds ago

    mockGetSkynetDB.mockReturnValue({
      getWorkerIntents: vi.fn(() => [
        makeDbRow({ heartbeatEpoch }),
      ]),
    });

    const { GET } = createWorkerIntentsHandler(makeConfig());
    const body = await (await GET()).json();

    expect(body.data.intents[0].heartbeatAgeMs).toBe(30000);
  });

  it("computes progressAgeMs from epoch seconds", async () => {
    const nowMs = Date.now();
    const progressEpoch = nowMs / 1000 - 60; // 60 seconds ago

    mockGetSkynetDB.mockReturnValue({
      getWorkerIntents: vi.fn(() => [
        makeDbRow({ progressEpoch }),
      ]),
    });

    const { GET } = createWorkerIntentsHandler(makeConfig());
    const body = await (await GET()).json();

    expect(body.data.intents[0].progressAgeMs).toBe(60000);
  });

  it("returns null age when heartbeatEpoch is null", async () => {
    mockGetSkynetDB.mockReturnValue({
      getWorkerIntents: vi.fn(() => [
        makeDbRow({ heartbeatEpoch: null, progressEpoch: null }),
      ]),
    });

    const { GET } = createWorkerIntentsHandler(makeConfig());
    const body = await (await GET()).json();

    expect(body.data.intents[0].heartbeatAgeMs).toBeNull();
    expect(body.data.intents[0].progressAgeMs).toBeNull();
  });

  // ── Multiple workers ──────────────────────────────────────────────

  it("returns multiple worker intents", async () => {
    mockGetSkynetDB.mockReturnValue({
      getWorkerIntents: vi.fn(() => [
        makeDbRow({ workerId: 1, status: "working" }),
        makeDbRow({ workerId: 2, status: "idle" }),
        makeDbRow({ workerId: 3, workerType: "fixer", status: "fixing" }),
      ]),
    });

    const { GET } = createWorkerIntentsHandler(makeConfig());
    const body = await (await GET()).json();

    expect(body.data.intents).toHaveLength(3);
    expect(body.data.intents[0].workerId).toBe(1);
    expect(body.data.intents[1].workerId).toBe(2);
    expect(body.data.intents[2].workerType).toBe("fixer");
  });

  // ── 500 error path ──────────────────────────────────────────────

  it("returns 500 when getSkynetDB throws", async () => {
    mockGetSkynetDB.mockImplementation(() => {
      throw new Error("db unavailable");
    });

    const { GET } = createWorkerIntentsHandler(makeConfig());
    const res = await GET();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.data).toBeNull();
    expect(body.error).toBeTruthy();
  });

  it("returns generic error message in production", async () => {
    const origEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";

    mockGetSkynetDB.mockImplementation(() => {
      throw new Error("secret db path leaked");
    });

    const { GET } = createWorkerIntentsHandler(makeConfig());
    const body = await (await GET()).json();

    expect(body.error).toBe("Failed to retrieve worker intents");
    process.env.NODE_ENV = origEnv;
  });

  it("returns detailed error message in development", async () => {
    const origEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";

    mockGetSkynetDB.mockImplementation(() => {
      throw new Error("SQLITE_CANTOPEN");
    });

    const { GET } = createWorkerIntentsHandler(makeConfig());
    const body = await (await GET()).json();

    expect(body.error).toBe("SQLITE_CANTOPEN");
    process.env.NODE_ENV = origEnv;
  });
});
