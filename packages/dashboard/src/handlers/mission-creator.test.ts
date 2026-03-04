import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMissionCreatorHandler } from "./mission-creator";
import type { SkynetConfig } from "../types";

// Mock child_process.spawn
const mockStdoutOn = vi.fn();
const mockStderrOn = vi.fn();
const mockStdinWrite = vi.fn();
const mockStdinEnd = vi.fn();
const mockOn = vi.fn();
const mockKill = vi.fn();

vi.mock("child_process", () => ({
  spawn: vi.fn(() => ({
    stdout: { on: mockStdoutOn },
    stderr: { on: mockStderrOn },
    stdin: { write: mockStdinWrite, end: mockStdinEnd },
    on: mockOn,
    kill: mockKill,
  })),
}));

function makeConfig(overrides?: Partial<SkynetConfig>): SkynetConfig {
  return {
    projectName: "test-project",
    devDir: "/tmp/test/.dev",
    lockPrefix: "/tmp/skynet-test-",
    workers: [],
    triggerableScripts: [],
    taskTags: [],
    ...overrides,
  };
}

function makeJsonRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/mission/creator", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function simulateClaudeOutput(json: unknown) {
  // Simulate stdout data event
  const stdoutDataCb = mockStdoutOn.mock.calls.find((c) => c[0] === "data")?.[1];
  if (stdoutDataCb) {
    stdoutDataCb(Buffer.from(JSON.stringify(json)));
  }
  // Simulate close event with success code
  const closeCb = mockOn.mock.calls.find((c) => c[0] === "close")?.[1];
  if (closeCb) {
    closeCb(0);
  }
}

function simulateClaudeError(code: number, stderr = "") {
  if (stderr) {
    const stderrDataCb = mockStderrOn.mock.calls.find((c) => c[0] === "data")?.[1];
    if (stderrDataCb) stderrDataCb(Buffer.from(stderr));
  }
  const closeCb = mockOn.mock.calls.find((c) => c[0] === "close")?.[1];
  if (closeCb) closeCb(code);
}

describe("createMissionCreatorHandler", () => {
  const originalMissionTimeout = process.env.SKYNET_MISSION_CREATOR_TIMEOUT_MS;
  const originalExpandTimeout = process.env.SKYNET_MISSION_EXPAND_TIMEOUT_MS;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SKYNET_MISSION_CREATOR_TIMEOUT_MS;
    delete process.env.SKYNET_MISSION_EXPAND_TIMEOUT_MS;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalMissionTimeout !== undefined) process.env.SKYNET_MISSION_CREATOR_TIMEOUT_MS = originalMissionTimeout;
    else delete process.env.SKYNET_MISSION_CREATOR_TIMEOUT_MS;
    if (originalExpandTimeout !== undefined) process.env.SKYNET_MISSION_EXPAND_TIMEOUT_MS = originalExpandTimeout;
    else delete process.env.SKYNET_MISSION_EXPAND_TIMEOUT_MS;
    vi.useRealTimers();
  });

  describe("POST (generate)", () => {
    it("returns 400 when input is missing", async () => {
      const handler = createMissionCreatorHandler(makeConfig());
      const res = await handler.POST(makeJsonRequest({}));
      const body = await res.json();
      expect(res.status).toBe(400);
      expect(body.error).toBe("Missing 'input' field (string)");
    });

    it("returns 400 when input is empty string", async () => {
      const handler = createMissionCreatorHandler(makeConfig());
      const res = await handler.POST(makeJsonRequest({ input: "  " }));
      const body = await res.json();
      expect(res.status).toBe(400);
      expect(body.error).toBe("Missing 'input' field (string)");
    });

    it("returns generated mission and suggestions on success", async () => {
      const handler = createMissionCreatorHandler(makeConfig());
      const mockResult = {
        mission: "# Mission\n\n## Purpose\nTest purpose",
        suggestions: [
          { title: "Suggestion 1", content: "Content 1" },
          { title: "Suggestion 2", content: "Content 2" },
          { title: "Suggestion 3", content: "Content 3" },
        ],
      };

      const promise = handler.POST(makeJsonRequest({ input: "Build a CI/CD pipeline" }));

      // Wait a tick for spawn to be called
      await new Promise((r) => setTimeout(r, 10));
      simulateClaudeOutput(mockResult);

      const res = await promise;
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.error).toBeNull();
      expect(body.data.mission).toBe(mockResult.mission);
      expect(body.data.suggestions).toHaveLength(3);
    });

    it("returns 500 when claude CLI fails", async () => {
      const handler = createMissionCreatorHandler(makeConfig());
      const promise = handler.POST(makeJsonRequest({ input: "Build something" }));

      await new Promise((r) => setTimeout(r, 10));
      simulateClaudeError(1, "Claude CLI not found");

      const res = await promise;
      const body = await res.json();
      expect(res.status).toBe(500);
      expect(body.error).toBe("Claude CLI not found");
    });

    it("returns 504 when generation times out", async () => {
      vi.useFakeTimers();
      process.env.SKYNET_MISSION_CREATOR_TIMEOUT_MS = "5000";

      const handler = createMissionCreatorHandler(makeConfig());
      const promise = handler.POST(makeJsonRequest({ input: "Large custom mission" }));

      await vi.advanceTimersByTimeAsync(5001);

      const res = await promise;
      const body = await res.json();
      expect(res.status).toBe(504);
      expect(body.error).toContain("timed out");
      expect(mockKill).toHaveBeenCalledWith("SIGTERM");
    });

    it("returns 502 when AI returns invalid shape", async () => {
      const handler = createMissionCreatorHandler(makeConfig());
      const promise = handler.POST(makeJsonRequest({ input: "Build something" }));

      await new Promise((r) => setTimeout(r, 10));
      simulateClaudeOutput({ invalid: "shape" });

      const res = await promise;
      const body = await res.json();
      expect(res.status).toBe(502);
      expect(body.error).toContain("AI returned invalid response shape");
    });

    it("pipes prompt via stdin", async () => {
      const handler = createMissionCreatorHandler(makeConfig());
      const promise = handler.POST(makeJsonRequest({ input: "Build a pipeline" }));

      await new Promise((r) => setTimeout(r, 10));
      expect(mockStdinWrite).toHaveBeenCalled();
      expect(mockStdinEnd).toHaveBeenCalled();
      const writtenPrompt = mockStdinWrite.mock.calls[0][0];
      expect(writtenPrompt).toContain("Build a pipeline");

      simulateClaudeOutput({
        mission: "# Mission",
        suggestions: [{ title: "S", content: "C" }],
      });
      await promise;
    });

    it("includes currentMission in prompt when provided", async () => {
      const handler = createMissionCreatorHandler(makeConfig());
      const promise = handler.POST(
        makeJsonRequest({ input: "Improve it", currentMission: "# Existing Mission" }),
      );

      await new Promise((r) => setTimeout(r, 10));
      const writtenPrompt = mockStdinWrite.mock.calls[0][0];
      expect(writtenPrompt).toContain("# Existing Mission");

      simulateClaudeOutput({
        mission: "# Mission",
        suggestions: [{ title: "S", content: "C" }],
      });
      await promise;
    });
  });

  describe("expand", () => {
    it("returns 400 when suggestion is missing", async () => {
      const handler = createMissionCreatorHandler(makeConfig());
      const req = new Request("http://localhost/mission/creator/expand", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const res = await handler.expand(req);
      const body = await res.json();
      expect(res.status).toBe(400);
      expect(body.error).toBe("Missing 'suggestion' field (string)");
    });

    it("returns expanded suggestions on success", async () => {
      const handler = createMissionCreatorHandler(makeConfig());
      const mockResult = {
        suggestions: [
          { title: "Sub 1", content: "Detail 1" },
          { title: "Sub 2", content: "Detail 2" },
          { title: "Sub 3", content: "Detail 3" },
        ],
      };

      const req = new Request("http://localhost/mission/creator/expand", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ suggestion: "Add monitoring", currentMission: "# Mission" }),
      });
      const promise = handler.expand(req);

      await new Promise((r) => setTimeout(r, 10));
      simulateClaudeOutput(mockResult);

      const res = await promise;
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.data.suggestions).toHaveLength(3);
    });

    it("returns 504 when expand times out", async () => {
      vi.useFakeTimers();
      process.env.SKYNET_MISSION_EXPAND_TIMEOUT_MS = "5000";

      const handler = createMissionCreatorHandler(makeConfig());
      const req = new Request("http://localhost/mission/creator/expand", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ suggestion: "Expand this", currentMission: "# Mission" }),
      });
      const promise = handler.expand(req);

      await vi.advanceTimersByTimeAsync(5001);

      const res = await promise;
      const body = await res.json();
      expect(res.status).toBe(504);
      expect(body.error).toContain("timed out");
      expect(mockKill).toHaveBeenCalledWith("SIGTERM");
    });
  });
});
