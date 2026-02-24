import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SkynetConfig } from "../types";
import type { FSWatcher } from "fs";
import { EventEmitter } from "events";

const mockWatch = vi.fn();

vi.mock("fs", () => ({
  watch: (...args: unknown[]) => mockWatch(...args),
}));

const mockGetStatus = vi.fn();

vi.mock("./pipeline-status", () => ({
  createPipelineStatusHandler: () => mockGetStatus,
}));

import { createPipelineStreamHandler, _resetActiveConnections } from "./pipeline-stream";

function makeConfig(overrides?: Partial<SkynetConfig>): SkynetConfig {
  return {
    projectName: "test-project", devDir: "/tmp/test/.dev", lockPrefix: "/tmp/skynet-test-",
    workers: [{ name: "dev-worker-1", label: "Dev Worker 1", category: "core", schedule: "On demand", description: "Implements tasks" }],
    triggerableScripts: [], taskTags: ["FEAT", "FIX"], ...overrides,
  };
}

function createMockWatcher(): FSWatcher & EventEmitter {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    close: vi.fn(),
    ref: vi.fn().mockReturnThis(),
    unref: vi.fn().mockReturnThis(),
    [Symbol.dispose]: vi.fn(),
  }) as unknown as FSWatcher & EventEmitter;
}

function makeStatusResponse(data: unknown = { workers: [] }) {
  return new Response(JSON.stringify({ data, error: null }), {
    headers: { "Content-Type": "application/json" },
  });
}

/** Flush pending microtasks so ReadableStream.start() finishes (watcher setup is async). */
async function flushAsync() {
  await vi.advanceTimersByTimeAsync(0);
}

/** Read and discard the initial "retry: 5000" SSE instruction. */
async function skipRetryInstruction(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const { value } = await reader.read();
  const text = new TextDecoder().decode(value);
  expect(text).toBe("retry: 5000\n\n");
}

describe("createPipelineStreamHandler", () => {
  let mockWatcher: FSWatcher & EventEmitter;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    _resetActiveConnections();
    mockWatcher = createMockWatcher();
    mockWatch.mockReturnValue(mockWatcher);
    mockGetStatus.mockResolvedValue(makeStatusResponse());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns response with SSE headers", async () => {
    const handler = createPipelineStreamHandler(makeConfig());
    const res = await handler();
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(res.headers.get("Cache-Control")).toBe("no-cache, no-transform");
    expect(res.headers.get("Connection")).toBe("keep-alive");
    res.body?.cancel();
  });

  it("sends initial status as SSE data event", async () => {
    const statusData = { workers: [{ name: "w1" }] };
    mockGetStatus.mockResolvedValue(makeStatusResponse(statusData));

    const handler = createPipelineStreamHandler(makeConfig());
    const res = await handler();
    const reader = res.body!.getReader();
    await skipRetryInstruction(reader);
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toMatch(/^data: /);
    expect(text).toMatch(/\n\n$/);
    const parsed = JSON.parse(text.replace("data: ", "").trim());
    expect(parsed.data).toEqual(statusData);
    reader.cancel();
  });

  it("calls fs.watch on the devDir", async () => {
    const handler = createPipelineStreamHandler(makeConfig({ devDir: "/my/.dev" }));
    const res = await handler();
    const reader = res.body!.getReader();
    await skipRetryInstruction(reader);
    await reader.read();
    await flushAsync();
    expect(mockWatch).toHaveBeenCalledWith("/my/.dev", expect.any(Function));
    reader.cancel();
  });

  it("sends updated status when .md file changes", async () => {
    const initialData = { workers: [] };
    const updatedData = { workers: [{ name: "updated" }] };
    mockGetStatus
      .mockResolvedValueOnce(makeStatusResponse(initialData))
      .mockResolvedValueOnce(makeStatusResponse(updatedData));

    const handler = createPipelineStreamHandler(makeConfig());
    const res = await handler();
    const reader = res.body!.getReader();
    await skipRetryInstruction(reader);
    await reader.read();
    await flushAsync();

    const watchCallback = mockWatch.mock.calls[0][1] as (event: string, filename: string) => void;
    watchCallback("change", "backlog.md");

    await vi.advanceTimersByTimeAsync(600);

    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    const parsed = JSON.parse(text.replace("data: ", "").trim());
    expect(parsed.data).toEqual(updatedData);
    reader.cancel();
  });

  it("ignores non-.md file changes", async () => {
    const handler = createPipelineStreamHandler(makeConfig());
    const res = await handler();
    const reader = res.body!.getReader();
    await skipRetryInstruction(reader);
    await reader.read();
    await flushAsync();

    const watchCallback = mockWatch.mock.calls[0][1] as (event: string, filename: string) => void;
    watchCallback("change", "config.sh");

    await vi.advanceTimersByTimeAsync(600);

    expect(mockGetStatus).toHaveBeenCalledTimes(1);
    reader.cancel();
  });

  it("debounces rapid .md file changes", async () => {
    const handler = createPipelineStreamHandler(makeConfig());
    const res = await handler();
    const reader = res.body!.getReader();
    await skipRetryInstruction(reader);
    await reader.read();
    await flushAsync();

    const watchCallback = mockWatch.mock.calls[0][1] as (event: string, filename: string) => void;

    watchCallback("change", "backlog.md");
    await vi.advanceTimersByTimeAsync(100);
    watchCallback("change", "completed.md");
    await vi.advanceTimersByTimeAsync(100);
    watchCallback("change", "failed-tasks.md");

    await vi.advanceTimersByTimeAsync(600);

    // Only initial + one debounced call
    expect(mockGetStatus).toHaveBeenCalledTimes(2);
    reader.cancel();
  });

  it("cleans up watcher and intervals on cancel", async () => {
    const handler = createPipelineStreamHandler(makeConfig());
    const res = await handler();
    const reader = res.body!.getReader();
    await skipRetryInstruction(reader);
    await reader.read();
    await flushAsync();

    await reader.cancel();

    expect(mockWatcher.close).toHaveBeenCalled();
  });

  it("sends status poll every 10 seconds", async () => {
    const statusData = { workers: [] };
    const updatedData = { workers: [{ name: "polled" }] };
    mockGetStatus
      .mockResolvedValueOnce(makeStatusResponse(statusData))
      .mockResolvedValueOnce(makeStatusResponse(updatedData));

    const handler = createPipelineStreamHandler(makeConfig());
    const res = await handler();
    const reader = res.body!.getReader();
    await skipRetryInstruction(reader);
    await reader.read(); // initial status
    await flushAsync();

    await vi.advanceTimersByTimeAsync(10_000);

    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toMatch(/^data: /);
    const parsed = JSON.parse(text.replace("data: ", "").trim());
    expect(parsed.data).toEqual(updatedData);
    reader.cancel();
  });

  it("handles watcher error by closing stream", async () => {
    const handler = createPipelineStreamHandler(makeConfig());
    const res = await handler();
    const reader = res.body!.getReader();
    await skipRetryInstruction(reader);
    await reader.read();
    await flushAsync();

    mockWatcher.emit("error", new Error("watch failed"));

    const { done } = await reader.read();
    expect(done).toBe(true);
    expect(mockWatcher.close).toHaveBeenCalled();
  });

  it("sends error event when getStatus throws", async () => {
    mockGetStatus.mockRejectedValueOnce(new Error("Status read failed"));

    const handler = createPipelineStreamHandler(makeConfig());
    const res = await handler();
    const reader = res.body!.getReader();
    await skipRetryInstruction(reader);
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    const parsed = JSON.parse(text.replace("data: ", "").trim());
    expect(parsed.data).toBeNull();
    // Error message is sanitized in non-development mode
    expect(parsed.error).toBe("Failed to read status");
    reader.cancel();
  });

  it("ignores null filename from watcher", async () => {
    const handler = createPipelineStreamHandler(makeConfig());
    const res = await handler();
    const reader = res.body!.getReader();
    await skipRetryInstruction(reader);
    await reader.read();
    await flushAsync();

    const watchCallback = mockWatch.mock.calls[0][1] as (event: string, filename: string | null) => void;
    watchCallback("change", null as unknown as string);

    await vi.advanceTimersByTimeAsync(600);
    expect(mockGetStatus).toHaveBeenCalledTimes(1);
    reader.cancel();
  });

  it("returns 503 when MAX_SSE_CONNECTIONS is exceeded", async () => {
    const handler = createPipelineStreamHandler(makeConfig());
    const connections: Response[] = [];

    // Open 20 connections (the maximum)
    for (let i = 0; i < 20; i++) {
      mockWatcher = createMockWatcher();
      mockWatch.mockReturnValue(mockWatcher);
      const res = await handler();
      connections.push(res);
    }

    // The 21st connection should be rejected with 503
    const rejected = await handler();
    expect(rejected.status).toBe(503);
    const body = await rejected.text();
    expect(body).toBe("Too many SSE connections");

    // Clean up all open connections
    for (const conn of connections) {
      conn.body?.cancel();
    }
  });
});
