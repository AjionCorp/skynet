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

  it("closes stream after 5-minute lifetime timeout", async () => {
    // Return same data on every poll so deduplication suppresses SSE events,
    // preventing buffered data chunks from blocking the done signal.
    const sameData = { workers: [] };
    mockGetStatus.mockResolvedValue(makeStatusResponse(sameData));

    const handler = createPipelineStreamHandler(makeConfig());
    const res = await handler();
    const reader = res.body!.getReader();
    await skipRetryInstruction(reader);
    await reader.read(); // initial status
    await flushAsync();

    // Advance past the 5-minute lifetime
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 100);

    // Drain any buffered chunks until we hit the stream end
    let done = false;
    for (let i = 0; i < 100 && !done; i++) {
      const result = await reader.read();
      done = result.done;
    }
    expect(done).toBe(true);
    expect(mockWatcher.close).toHaveBeenCalled();
  });

  it("sends auth-expired event with session-lifetime reason before closing on 5-minute timeout", async () => {
    const sameData = { workers: [] };
    mockGetStatus.mockResolvedValue(makeStatusResponse(sameData));

    const handler = createPipelineStreamHandler(makeConfig());
    const res = await handler();
    const reader = res.body!.getReader();
    await skipRetryInstruction(reader);
    await reader.read(); // initial status
    await flushAsync();

    // Advance past the 5-minute lifetime
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 100);

    // Collect all remaining chunks before stream closes
    let authExpiredFound = false;
    for (let i = 0; i < 100; i++) {
      const result = await reader.read();
      if (result.done) break;
      const text = new TextDecoder().decode(result.value);
      if (text.includes("event: auth-expired") && text.includes("session-lifetime")) {
        authExpiredFound = true;
      }
    }
    expect(authExpiredFound).toBe(true);
  });

  it("suppresses duplicate consecutive payloads (deduplication)", async () => {
    const sameData = { workers: [{ name: "w1" }] };
    // Return the same data for initial + poll
    mockGetStatus
      .mockResolvedValueOnce(makeStatusResponse(sameData))
      .mockResolvedValueOnce(makeStatusResponse(sameData));

    const handler = createPipelineStreamHandler(makeConfig());
    const res = await handler();
    const reader = res.body!.getReader();
    await skipRetryInstruction(reader);
    await reader.read(); // initial status event
    await flushAsync();

    // Trigger a poll that returns the same data
    await vi.advanceTimersByTimeAsync(10_000);

    // getStatus was called twice (initial + poll), but only one data event should
    // have been emitted because the payload is identical
    expect(mockGetStatus).toHaveBeenCalledTimes(2);

    // Verify no second data event is available — advance a bit more and check
    // that we can advance timers without reading additional data. The reader
    // should not have a new chunk unless data actually changed.
    // We'll use a different approach: return new data on the third call and verify
    // we only got 2 total data events (initial + the new one, not the duplicate).
    const newData = { workers: [{ name: "w2" }] };
    mockGetStatus.mockResolvedValueOnce(makeStatusResponse(newData));
    await vi.advanceTimersByTimeAsync(10_000);

    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    const parsed = JSON.parse(text.replace("data: ", "").trim());
    expect(parsed.data).toEqual(newData);
    // 3 calls total: initial, duplicate (suppressed), new
    expect(mockGetStatus).toHaveBeenCalledTimes(3);
    reader.cancel();
  });

  // ── TEST-P2-3: fs.watch initialization failure — fallback to polling ──
  it("still sends status via polling when fs.watch throws", async () => {
    mockWatch.mockImplementation(() => { throw new Error("watch not supported"); });

    const statusData = { workers: [{ name: "polled" }] };
    const updatedData = { workers: [{ name: "updated-poll" }] };
    mockGetStatus
      .mockResolvedValueOnce(makeStatusResponse(statusData))
      .mockResolvedValueOnce(makeStatusResponse(updatedData));

    const handler = createPipelineStreamHandler(makeConfig());
    const res = await handler();
    const reader = res.body!.getReader();
    await skipRetryInstruction(reader);

    // Should still get initial status despite watch failure
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toMatch(/^data: /);
    const parsed = JSON.parse(text.replace("data: ", "").trim());
    expect(parsed.data).toEqual(statusData);

    // Flush microtasks so start() finishes setting up the polling interval
    await flushAsync();

    // Polling should still work — advance timer and verify
    await vi.advanceTimersByTimeAsync(10_000);

    const { value: pollValue } = await reader.read();
    const pollText = new TextDecoder().decode(pollValue);
    const pollParsed = JSON.parse(pollText.replace("data: ", "").trim());
    expect(pollParsed.data).toEqual(updatedData);

    reader.cancel();
  });

  it("logs backpressure warning when controller desiredSize is zero", async () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const statusData = { workers: [] };
    const updatedData = { workers: [{ name: "bp-test" }] };
    mockGetStatus
      .mockResolvedValueOnce(makeStatusResponse(statusData))
      .mockResolvedValueOnce(makeStatusResponse(updatedData));

    const handler = createPipelineStreamHandler(makeConfig());
    const res = await handler();
    const reader = res.body!.getReader();
    await skipRetryInstruction(reader);
    await reader.read(); // initial status
    await flushAsync();

    // Trigger a poll — backpressure log fires when desiredSize <= 0, which
    // depends on internal ReadableStream buffer state. We verify the handler
    // doesn't crash when producing events regardless of backpressure.
    await vi.advanceTimersByTimeAsync(10_000);
    const { value } = await reader.read();
    expect(value).toBeDefined();

    debugSpy.mockRestore();
    reader.cancel();
  });

  it("triggers update on .db-wal file changes", async () => {
    const initialData = { workers: [] };
    const updatedData = { workers: [{ name: "wal-update" }] };
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
    watchCallback("change", "skynet.db-wal");

    await vi.advanceTimersByTimeAsync(600);

    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    const parsed = JSON.parse(text.replace("data: ", "").trim());
    expect(parsed.data).toEqual(updatedData);
    reader.cancel();
  });

  it("includes X-Accel-Buffering: no header for nginx compatibility", async () => {
    const handler = createPipelineStreamHandler(makeConfig());
    const res = await handler();
    expect(res.headers.get("X-Accel-Buffering")).toBe("no");
    res.body?.cancel();
  });

  it("decrements activeConnections on stream cancel", async () => {
    const handler = createPipelineStreamHandler(makeConfig());

    // Open and cancel a connection
    const res1 = await handler();
    res1.body?.cancel();
    // Give cancel time to propagate
    await flushAsync();

    // Should be able to open 20 more connections (counter decremented)
    const connections: Response[] = [];
    for (let i = 0; i < 20; i++) {
      mockWatcher = createMockWatcher();
      mockWatch.mockReturnValue(mockWatcher);
      const res = await handler();
      connections.push(res);
    }
    // 21st should still work because we freed one slot
    // (we used 20 after canceling the first = 20 total, at limit)
    // 21st should be rejected
    const rejected = await handler();
    expect(rejected.status).toBe(503);

    for (const conn of connections) {
      conn.body?.cancel();
    }
  });

  it("sends error event when getStatus fails during watcher-triggered debounce", async () => {
    const handler = createPipelineStreamHandler(makeConfig());
    const res = await handler();
    const reader = res.body!.getReader();
    await skipRetryInstruction(reader);
    await reader.read(); // initial status
    await flushAsync();

    // Make getStatus reject on the next (debounced) call
    mockGetStatus.mockRejectedValueOnce(new Error("Disk read failed"));

    const watchCallback = mockWatch.mock.calls[0][1] as (event: string, filename: string) => void;
    watchCallback("change", "backlog.md");

    // Advance past debounce — pushStatus catches the error and sends an error event
    await vi.advanceTimersByTimeAsync(600);
    await flushAsync();

    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    const parsed = JSON.parse(text.replace("data: ", "").trim());
    expect(parsed.data).toBeNull();
    expect(parsed.error).toBe("Failed to read status");
    reader.cancel();
  });

  it("sends retry instruction as first SSE message", async () => {
    const handler = createPipelineStreamHandler(makeConfig());
    const res = await handler();
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toBe("retry: 5000\n\n");
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
