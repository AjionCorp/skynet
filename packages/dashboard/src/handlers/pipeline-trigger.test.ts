import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPipelineTriggerHandler } from "./pipeline-trigger";
import type { SkynetConfig } from "../types";

const mockUnref = vi.fn();

vi.mock("child_process", () => ({
  spawn: vi.fn(() => ({ unref: mockUnref })),
}));
vi.mock("fs", () => ({
  openSync: vi.fn(() => 3),
  closeSync: vi.fn(),
  existsSync: vi.fn(() => true),
  constants: { O_WRONLY: 1, O_CREAT: 64, O_APPEND: 1024 },
}));

import { spawn } from "child_process";
import { openSync } from "fs";

const mockSpawn = vi.mocked(spawn);
const mockOpenSync = vi.mocked(openSync);

function makeConfig(overrides?: Partial<SkynetConfig>): SkynetConfig {
  return {
    projectName: "test-project", devDir: "/tmp/test/.dev", lockPrefix: "/tmp/skynet-test-",
    workers: [{ name: "dev-worker-1", label: "Dev Worker 1", category: "core", schedule: "On demand", description: "Implements tasks" }],
    triggerableScripts: ["watchdog", "dev-worker"], taskTags: ["FEAT", "FIX"], ...overrides,
  };
}

function makePostRequest(body: unknown): Request {
  return new Request("http://localhost/api/pipeline/trigger", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("createPipelineTriggerHandler", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.NODE_ENV = "development";
    vi.clearAllMocks();
    mockUnref.mockReset();
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it("returns 400 when script is not in triggerableScripts", async () => {
    const handler = createPipelineTriggerHandler(makeConfig());
    const res = await handler(makePostRequest({ script: "not-allowed" }));
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.data).toBeNull();
    expect(body.error).toContain("Invalid script");
    expect(body.error).toContain("watchdog");
  });

  it("returns 400 when triggerableScripts is empty", async () => {
    const config = makeConfig({ triggerableScripts: [] });
    const handler = createPipelineTriggerHandler(config);
    const res = await handler(makePostRequest({ script: "watchdog" }));
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toContain("Invalid script");
  });

  it("returns 200 with triggered: true for valid script", async () => {
    const handler = createPipelineTriggerHandler(makeConfig());
    const res = await handler(makePostRequest({ script: "watchdog" }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.error).toBeNull();
    expect(body.data).toEqual({ triggered: true, script: "watchdog" });
  });

  it("calls spawn with bash and the script path", async () => {
    const handler = createPipelineTriggerHandler(makeConfig());
    await handler(makePostRequest({ script: "watchdog" }));
    expect(mockSpawn).toHaveBeenCalledWith(
      "bash",
      expect.arrayContaining([expect.stringContaining("watchdog.sh")]),
      expect.objectContaining({ detached: true }),
    );
  });

  it("calls child.unref() to detach the process", async () => {
    const handler = createPipelineTriggerHandler(makeConfig());
    await handler(makePostRequest({ script: "watchdog" }));
    expect(mockUnref).toHaveBeenCalled();
  });

  it("returns 400 for invalid arg containing special characters", async () => {
    const handler = createPipelineTriggerHandler(makeConfig());
    const res = await handler(makePostRequest({ script: "watchdog", args: ["../etc"] }));
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toBe("Invalid argument");
  });

  it("accepts valid alphanumeric args", async () => {
    const handler = createPipelineTriggerHandler(makeConfig());
    const res = await handler(makePostRequest({ script: "dev-worker", args: ["1"] }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.triggered).toBe(true);
  });

  it("passes args to spawn command", async () => {
    const handler = createPipelineTriggerHandler(makeConfig());
    await handler(makePostRequest({ script: "dev-worker", args: ["2"] }));
    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs).toContain("2");
  });

  it("accepts numbered dev-worker aliases and prepends the worker id", async () => {
    const handler = createPipelineTriggerHandler(makeConfig());
    const res = await handler(makePostRequest({ script: "dev-worker-3" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual({ triggered: true, script: "dev-worker-3" });
    expect(mockSpawn).toHaveBeenCalledWith(
      "bash",
      expect.arrayContaining([expect.stringContaining("dev-worker.sh"), "3"]),
      expect.any(Object),
    );
    expect(mockOpenSync).toHaveBeenCalledWith(
      expect.stringContaining("dev-worker-3.log"),
      expect.any(Number),
    );
  });

  it("accepts numbered task-fixer aliases and uses the canonical fixer log name", async () => {
    const handler = createPipelineTriggerHandler(makeConfig({
      triggerableScripts: ["watchdog", "dev-worker", "task-fixer"],
    }));
    const res = await handler(makePostRequest({ script: "task-fixer-1" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual({ triggered: true, script: "task-fixer-1" });
    expect(mockSpawn).toHaveBeenCalledWith(
      "bash",
      expect.arrayContaining([expect.stringContaining("task-fixer.sh"), "1"]),
      expect.any(Object),
    );
    expect(mockOpenSync).toHaveBeenCalledWith(
      expect.stringContaining("task-fixer.log"),
      expect.any(Number),
    );
  });

  it("defaults args to empty array when not provided", async () => {
    const handler = createPipelineTriggerHandler(makeConfig());
    await handler(makePostRequest({ script: "watchdog" }));
    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs).toHaveLength(1); // just the script path
  });

  it("opens log file for writing", async () => {
    const handler = createPipelineTriggerHandler(makeConfig());
    await handler(makePostRequest({ script: "watchdog" }));
    expect(mockOpenSync).toHaveBeenCalledWith(
      expect.stringContaining("watchdog.log"),
      expect.any(Number),
    );
  });

  it("uses args[0] as log suffix when args provided", async () => {
    const handler = createPipelineTriggerHandler(makeConfig());
    await handler(makePostRequest({ script: "dev-worker", args: ["3"] }));
    expect(mockOpenSync).toHaveBeenCalledWith(
      expect.stringContaining("dev-worker-3.log"),
      expect.any(Number),
    );
  });

  it("returns 500 with error message when spawn throws", async () => {
    mockSpawn.mockImplementation(() => { throw new Error("spawn failed"); });
    const handler = createPipelineTriggerHandler(makeConfig());
    const res = await handler(makePostRequest({ script: "watchdog" }));
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.data).toBeNull();
    expect(body.error).toBe("spawn failed");
  });

  // TEST-P2-1: args array with null/undefined items returns 400
  it("returns 400 when args array contains null or non-string items", async () => {
    const handler = createPipelineTriggerHandler(makeConfig());
    const res = await handler(makePostRequest({ script: "watchdog", args: [null, undefined, 42] }));
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toBe("Invalid argument");
  });

  it("returns 400 when request body is not valid JSON", async () => {
    const handler = createPipelineTriggerHandler(makeConfig());
    const req = new Request("http://localhost/api/pipeline/trigger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    const res = await handler(req);
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.data).toBeNull();
    expect(body.error).toBeTruthy();
  });

  // ── P1-12: Previously untested branches ──────────────────────────
  it("returns 404 when script file does not exist", async () => {
    const { existsSync } = await import("fs");
    const mockExistsSync = vi.mocked(existsSync);
    mockExistsSync.mockReturnValue(false);

    const handler = createPipelineTriggerHandler(makeConfig());
    const res = await handler(makePostRequest({ script: "watchdog" }));
    const body = await res.json();
    expect(res.status).toBe(404);
    expect(body.data).toBeNull();
    expect(body.error).toBe("Script not found");
  });

  it("returns 400 when args exceed 10 items", async () => {
    const handler = createPipelineTriggerHandler(makeConfig());
    const tooManyArgs = Array.from({ length: 11 }, (_, i) => String(i));
    const res = await handler(makePostRequest({ script: "watchdog", args: tooManyArgs }));
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toContain("Too many arguments");
  });

  it("returns 400 for unsafe script name with special characters", async () => {
    const handler = createPipelineTriggerHandler(makeConfig({
      triggerableScripts: ["watchdog", "dev-worker", "BAD_SCRIPT"],
    }));
    const res = await handler(makePostRequest({ script: "BAD_SCRIPT" }));
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toBe("Invalid script name");
  });
});


// ── Test-1: Shell metacharacter and injection tests ─────────────────

describe("pipeline-trigger argument injection tests", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(async () => {
    process.env.NODE_ENV = "development";
    vi.clearAllMocks();
    mockUnref.mockReset();
    // Re-establish mock implementations after clearAllMocks wipes them
    const fs = await import("fs");
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.openSync).mockReturnValue(3 as never);
    mockSpawn.mockReturnValue({ unref: mockUnref } as never);
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  describe("rejects shell metacharacters in args", () => {
    const dangerousArgs = [
      { char: ";", arg: "foo;rm -rf /" },
      { char: "|", arg: "foo|cat /etc/passwd" },
      { char: "&&", arg: "foo&&whoami" },
      { char: "`", arg: "`whoami`" },
      { char: "$()", arg: "$(id)" },
      { char: "$(...)", arg: "a$(cat /etc/shadow)" },
      { char: ">", arg: "foo>out" },
      { char: "<", arg: "foo<in" },
      { char: "newline", arg: "foo\nbar" },
      { char: "space", arg: "foo bar" },
      { char: "tab", arg: "foo\tbar" },
      { char: "single-quote", arg: "foo'bar" },
      { char: "double-quote", arg: 'foo"bar' },
      { char: "backslash", arg: "foo\\bar" },
      { char: "curly-brace", arg: "${PATH}" },
      { char: "exclamation", arg: "!important" },
      { char: "hash", arg: "#comment" },
      { char: "tilde", arg: "~root" },
      { char: "asterisk", arg: "*.sh" },
      { char: "question-mark", arg: "file?.txt" },
    ];

    for (const { char, arg } of dangerousArgs) {
      it(`rejects "${char}" — arg: ${JSON.stringify(arg)}`, async () => {
        const handler = createPipelineTriggerHandler(makeConfig());
        const res = await handler(makePostRequest({ script: "watchdog", args: [arg] }));
        const body = await res.json();
        expect(res.status).toBe(400);
        expect(body.error).toBe("Invalid argument");
      });
    }
  });

  describe("rejects path traversal in args", () => {
    const traversalArgs = [
      "../../../etc/passwd",
      "../../secret",
      "../config",
      "foo/../bar",
      "..",
      "...",
    ];

    for (const arg of traversalArgs) {
      it(`rejects path traversal: ${JSON.stringify(arg)}`, async () => {
        const handler = createPipelineTriggerHandler(makeConfig());
        const res = await handler(makePostRequest({ script: "watchdog", args: [arg] }));
        const body = await res.json();
        expect(res.status).toBe(400);
        expect(body.error).toBe("Invalid argument");
      });
    }
  });

  it("rejects args count exceeding max (10)", async () => {
    const handler = createPipelineTriggerHandler(makeConfig());
    const tooManyArgs = Array.from({ length: 11 }, (_, i) => String(i));
    const res = await handler(makePostRequest({ script: "watchdog", args: tooManyArgs }));
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toContain("Too many arguments");
  });

  it("accepts exactly 10 args (boundary)", async () => {
    const handler = createPipelineTriggerHandler(makeConfig());
    const maxArgs = Array.from({ length: 10 }, (_, i) => String(i));
    const res = await handler(makePostRequest({ script: "watchdog", args: maxArgs }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.triggered).toBe(true);
  });

  it("rejects arg length exceeding max (64 chars)", async () => {
    const handler = createPipelineTriggerHandler(makeConfig());
    const longArg = "a".repeat(65);
    const res = await handler(makePostRequest({ script: "watchdog", args: [longArg] }));
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toBe("Invalid argument");
  });

  it("accepts arg at exactly 64 chars (boundary)", async () => {
    const handler = createPipelineTriggerHandler(makeConfig());
    const exactArg = "a".repeat(64);
    const res = await handler(makePostRequest({ script: "watchdog", args: [exactArg] }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.triggered).toBe(true);
  });

  describe("valid args pass through correctly", () => {
    const validArgs = [
      { desc: "single digit", args: ["1"] },
      { desc: "alphanumeric", args: ["abc123"] },
      { desc: "hyphenated", args: ["dev-worker"] },
      { desc: "multiple valid args", args: ["1", "foo", "bar-baz"] },
      { desc: "numeric worker IDs", args: ["1", "2", "3"] },
    ];

    for (const { desc, args } of validArgs) {
      it(`accepts valid args: ${desc}`, async () => {
        const handler = createPipelineTriggerHandler(makeConfig());
        const res = await handler(makePostRequest({ script: "watchdog", args }));
        const body = await res.json();
        expect(res.status).toBe(200);
        expect(body.data.triggered).toBe(true);
        expect(body.error).toBeNull();
      });
    }
  });

  it("accepts empty args array", async () => {
    const handler = createPipelineTriggerHandler(makeConfig());
    const res = await handler(makePostRequest({ script: "watchdog", args: [] }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.triggered).toBe(true);
    expect(body.error).toBeNull();
  });

  it("passes validated args through to spawn", async () => {
    const handler = createPipelineTriggerHandler(makeConfig());
    await handler(makePostRequest({ script: "dev-worker", args: ["3", "extra"] }));
    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs).toContain("3");
    expect(spawnArgs).toContain("extra");
  });
});
