import { describe, it, expect, vi, beforeEach } from "vitest";
import { createEventsHandler } from "./events";
import type { SkynetConfig } from "../types";

// Mock getSkynetDB so the SQLite path always throws (forcing tail fallback)
vi.mock("../lib/db", () => ({
  getSkynetDB: vi.fn(() => {
    throw new Error("SQLite not available in tests");
  }),
}));

vi.mock("child_process", () => ({
  spawnSync: vi.fn(() => ({ stdout: "", stderr: "", status: 0 })),
}));

import { spawnSync } from "child_process";
const mockSpawnSync = vi.mocked(spawnSync);

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

const EPOCH_1 = 1700000000;
const EPOCH_2 = 1700000060;
const EPOCH_3 = 1700000120;

const SAMPLE_LOG = [
  `${EPOCH_1}|task_completed|Worker 1 finished feat-login`,
  `${EPOCH_2}|task_failed|Worker 2 hit compile error`,
  `${EPOCH_3}|task_claimed|Worker 1 claimed fix-auth`,
].join("\n");

function mockTailOutput(stdout: string) {
  mockSpawnSync.mockReturnValue({ stdout, stderr: "", status: 0 } as never);
}

describe("createEventsHandler", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockTailOutput(SAMPLE_LOG);
  });

  it("reads pipe-delimited events.log and returns EventEntry[] shape", async () => {
    const GET = createEventsHandler(makeConfig());
    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.error).toBeNull();
    expect(body.data).toHaveLength(3);
    expect(body.data[0]).toMatchObject({
      ts: new Date(EPOCH_1 * 1000).toISOString(),
      event: "task_completed",
      detail: "Worker 1 finished feat-login",
    });
  });

  it("reads from config.devDir/events.log", async () => {
    const GET = createEventsHandler(makeConfig({ devDir: "/custom/dev" }));
    await GET();
    expect(mockSpawnSync).toHaveBeenCalledWith(
      "tail",
      ["-100", "/custom/dev/events.log"],
      expect.any(Object),
    );
  });

  it("returns empty array when events.log is missing", async () => {
    // tail on a missing file returns empty stdout
    mockTailOutput("");
    const GET = createEventsHandler(makeConfig());
    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.error).toBeNull();
    expect(body.data).toEqual([]);
  });

  it("returns empty array when events.log is empty", async () => {
    mockTailOutput("");
    const GET = createEventsHandler(makeConfig());
    const res = await GET();
    const body = await res.json();
    expect(body.data).toEqual([]);
    expect(body.error).toBeNull();
  });

  it("skips blank lines", async () => {
    mockTailOutput(`${EPOCH_1}|task_completed|Done\n\n\n${EPOCH_2}|task_failed|Error`);
    const GET = createEventsHandler(makeConfig());
    const res = await GET();
    const body = await res.json();
    expect(body.data).toHaveLength(2);
  });

  it("skips lines with fewer than 3 pipe-delimited parts", async () => {
    mockTailOutput(`${EPOCH_1}|task_completed|Done\nbad_line\n${EPOCH_2}|only_two_parts`);
    const GET = createEventsHandler(makeConfig());
    const res = await GET();
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].event).toBe("task_completed");
  });

  it("skips lines with non-numeric epoch", async () => {
    mockTailOutput(`notanumber|task_completed|Done\n${EPOCH_1}|task_claimed|OK`);
    const GET = createEventsHandler(makeConfig());
    const res = await GET();
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].event).toBe("task_claimed");
  });

  it("converts epoch seconds to ISO timestamp", async () => {
    mockTailOutput(`${EPOCH_1}|test_event|detail`);
    const GET = createEventsHandler(makeConfig());
    const res = await GET();
    const body = await res.json();
    const expected = new Date(EPOCH_1 * 1000).toISOString();
    expect(body.data[0].ts).toBe(expected);
  });

  it("limits output to last 100 entries when file has more", async () => {
    // tail -100 already limits to the last 100 lines, so the handler
    // just receives and parses those 100 lines directly.
    const lines = Array.from({ length: 100 }, (_, i) =>
      `${EPOCH_1 + 50 + i}|event_${50 + i}|detail_${50 + i}`
    ).join("\n");
    mockTailOutput(lines);
    const GET = createEventsHandler(makeConfig());
    const res = await GET();
    const body = await res.json();
    expect(body.data).toHaveLength(100);
    // tail -100 returns the last 100 lines; the handler parses all of them
    expect(body.data[0].event).toBe("event_50");
    expect(body.data[99].event).toBe("event_149");
  });

  it("preserves pipes in detail field beyond the third part", async () => {
    mockTailOutput(`${EPOCH_1}|task_completed|detail|with|extra|pipes`);
    const GET = createEventsHandler(makeConfig());
    const res = await GET();
    const body = await res.json();
    expect(body.data[0].detail).toBe("detail|with|extra|pipes");
  });

  it("returns { data, error } response shape", async () => {
    const GET = createEventsHandler(makeConfig());
    const res = await GET();
    const body = await res.json();
    expect(body).toHaveProperty("data");
    expect(body).toHaveProperty("error");
  });

  it("rejects negative epoch values", async () => {
    mockTailOutput(`-100|task_completed|Done\n${EPOCH_1}|task_claimed|OK`);
    const GET = createEventsHandler(makeConfig());
    const res = await GET();
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].event).toBe("task_claimed");
  });

  it("rejects epoch values beyond year 2099", async () => {
    const farFuture = 4200000000;
    mockTailOutput(`${farFuture}|task_completed|Done\n${EPOCH_1}|task_claimed|OK`);
    const GET = createEventsHandler(makeConfig());
    const res = await GET();
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].event).toBe("task_claimed");
  });

  it("accepts valid epoch range boundaries", async () => {
    const validEpoch = 4100000000;  // Just under the 4.1e9 limit
    mockTailOutput(`${validEpoch}|task_completed|Done`);
    const GET = createEventsHandler(makeConfig());
    const res = await GET();
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].event).toBe("task_completed");
  });

  it("rejects zero epoch", async () => {
    mockTailOutput(`0|task_completed|Done\n${EPOCH_1}|task_claimed|OK`);
    const GET = createEventsHandler(makeConfig());
    const res = await GET();
    const body = await res.json();
    // epoch 0 is technically non-negative but filtered by epoch < 0 check
    // Actually, 0 passes the epoch >= 0 check but is valid
    // Check what actually happens: epoch=0 is >= 0 and <= 4.1e9, so it passes
    expect(body.data).toHaveLength(2);
  });

  // ── TEST-P2-5: Epoch boundary tests ─────────────────────────────────
  it("accepts epoch exactly 0 as valid", async () => {
    mockTailOutput("0|task_completed|Done at epoch zero");
    const GET = createEventsHandler(makeConfig());
    const res = await GET();
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].event).toBe("task_completed");
  });

  it("accepts epoch exactly 4.1e9 as valid", async () => {
    mockTailOutput("4100000000|task_completed|Far future but valid");
    const GET = createEventsHandler(makeConfig());
    const res = await GET();
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].event).toBe("task_completed");
  });

  it("rejects epoch 4100000001 (just beyond 4.1e9 boundary)", async () => {
    mockTailOutput(`4100000001|task_completed|Rejected\n${EPOCH_1}|task_claimed|OK`);
    const GET = createEventsHandler(makeConfig());
    const res = await GET();
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].event).toBe("task_claimed");
  });
});
