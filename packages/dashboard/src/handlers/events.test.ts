import { describe, it, expect, vi, beforeEach } from "vitest";
import { createEventsHandler } from "./events";
import type { SkynetConfig } from "../types";

vi.mock("fs", () => ({
  readFileSync: vi.fn(() => ""),
}));

import { readFileSync } from "fs";
const mockReadFileSync = vi.mocked(readFileSync);

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

describe("createEventsHandler", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockReadFileSync.mockReturnValue(SAMPLE_LOG);
  });

  it("reads pipe-delimited events.log and returns EventEntry[] shape", async () => {
    const GET = createEventsHandler(makeConfig());
    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.error).toBeNull();
    expect(body.data).toHaveLength(3);
    expect(body.data[0]).toEqual({
      ts: new Date(EPOCH_1 * 1000).toISOString(),
      event: "task_completed",
      detail: "Worker 1 finished feat-login",
    });
  });

  it("reads from config.devDir/events.log", async () => {
    const GET = createEventsHandler(makeConfig({ devDir: "/custom/dev" }));
    await GET();
    expect(mockReadFileSync).toHaveBeenCalledWith("/custom/dev/events.log", "utf-8");
  });

  it("returns empty array when events.log is missing", async () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT: no such file");
    });
    const GET = createEventsHandler(makeConfig());
    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.error).toBeNull();
    expect(body.data).toEqual([]);
  });

  it("returns empty array when events.log is empty", async () => {
    mockReadFileSync.mockReturnValue("");
    const GET = createEventsHandler(makeConfig());
    const res = await GET();
    const body = await res.json();
    expect(body.data).toEqual([]);
    expect(body.error).toBeNull();
  });

  it("skips blank lines", async () => {
    mockReadFileSync.mockReturnValue(`${EPOCH_1}|task_completed|Done\n\n\n${EPOCH_2}|task_failed|Error`);
    const GET = createEventsHandler(makeConfig());
    const res = await GET();
    const body = await res.json();
    expect(body.data).toHaveLength(2);
  });

  it("skips lines with fewer than 3 pipe-delimited parts", async () => {
    mockReadFileSync.mockReturnValue(`${EPOCH_1}|task_completed|Done\nbad_line\n${EPOCH_2}|only_two_parts`);
    const GET = createEventsHandler(makeConfig());
    const res = await GET();
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].event).toBe("task_completed");
  });

  it("skips lines with non-numeric epoch", async () => {
    mockReadFileSync.mockReturnValue(`notanumber|task_completed|Done\n${EPOCH_1}|task_claimed|OK`);
    const GET = createEventsHandler(makeConfig());
    const res = await GET();
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].event).toBe("task_claimed");
  });

  it("converts epoch seconds to ISO timestamp", async () => {
    mockReadFileSync.mockReturnValue(`${EPOCH_1}|test_event|detail`);
    const GET = createEventsHandler(makeConfig());
    const res = await GET();
    const body = await res.json();
    const expected = new Date(EPOCH_1 * 1000).toISOString();
    expect(body.data[0].ts).toBe(expected);
  });

  it("limits output to last 100 entries when file has more", async () => {
    const lines = Array.from({ length: 150 }, (_, i) =>
      `${EPOCH_1 + i}|event_${i}|detail_${i}`
    ).join("\n");
    mockReadFileSync.mockReturnValue(lines);
    const GET = createEventsHandler(makeConfig());
    const res = await GET();
    const body = await res.json();
    expect(body.data).toHaveLength(100);
    // Should keep the LAST 100 (entries 50-149)
    expect(body.data[0].event).toBe("event_50");
    expect(body.data[99].event).toBe("event_149");
  });

  it("preserves pipes in detail field beyond the third part", async () => {
    mockReadFileSync.mockReturnValue(`${EPOCH_1}|task_completed|detail|with|extra|pipes`);
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
});
