import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPromptsHandler } from "./prompts";
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
    scriptsDir: "/tmp/test/.dev/scripts",
    workers: [
      {
        name: "dev-worker",
        label: "Dev Worker",
        category: "core",
        schedule: "On demand",
        description: "Implements tasks via Claude Code",
      },
      {
        name: "health-check",
        label: "Health Check",
        category: "infra",
        schedule: "Daily 8am",
        description: "Typecheck + lint",
      },
    ],
    triggerableScripts: [],
    taskTags: [],
    ...overrides,
  };
}

function makeScriptContent(prompt: string): string {
  return [
    "#!/usr/bin/env bash",
    'source "$(dirname "$0")/_config.sh"',
    "",
    'PROMPT="' + prompt + '"',
    "",
    'claude --print "$PROMPT"',
  ].join("\n");
}

describe("createPromptsHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns { data: [], error: null } when no scripts exist", async () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const handler = createPromptsHandler(makeConfig());
    const res = await handler();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.error).toBeNull();
    expect(body.data).toEqual([]);
  });

  it("extracts prompt from script with PROMPT= block", async () => {
    mockReadFileSync.mockImplementation((path) => {
      if (String(path).includes("dev-worker.sh")) {
        return makeScriptContent("You are a dev worker. Implement the task.") as never;
      }
      throw new Error("ENOENT");
    });

    const handler = createPromptsHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();

    expect(data).toHaveLength(1);
    expect(data[0].scriptName).toBe("dev-worker");
    expect(data[0].prompt).toBe("You are a dev worker. Implement the task.");
    expect(data[0].workerLabel).toBe("Dev Worker");
    expect(data[0].description).toBe("Implements tasks via Claude Code");
    expect(data[0].category).toBe("core");
  });

  it("skips scripts with no PROMPT= marker", async () => {
    mockReadFileSync.mockImplementation((path) => {
      if (String(path).includes("dev-worker.sh")) {
        return '#!/bin/bash\necho "no prompt here"' as never;
      }
      throw new Error("ENOENT");
    });

    const handler = createPromptsHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();

    expect(data).toHaveLength(0);
  });

  it("handles escaped quotes within prompt content", async () => {
    mockReadFileSync.mockImplementation((path) => {
      if (String(path).includes("dev-worker.sh")) {
        return 'PROMPT="Say \\"hello\\" to the user"' as never;
      }
      throw new Error("ENOENT");
    });

    const handler = createPromptsHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();

    expect(data).toHaveLength(1);
    expect(data[0].prompt).toBe('Say \\"hello\\" to the user');
  });

  it("generates fallback label when worker not found in config", async () => {
    mockReadFileSync.mockImplementation((path) => {
      if (String(path).includes("task-fixer.sh")) {
        return makeScriptContent("Fix broken tasks") as never;
      }
      throw new Error("ENOENT");
    });

    const handler = createPromptsHandler(makeConfig({ workers: [] }));
    const res = await handler();
    const { data } = await res.json();

    expect(data).toHaveLength(1);
    expect(data[0].workerLabel).toBe("Task Fixer");
    expect(data[0].description).toBe("");
    expect(data[0].category).toBe("core");
  });

  it("matches worker by name prefix (e.g. dev-worker matches dev-worker-1)", async () => {
    mockReadFileSync.mockImplementation((path) => {
      if (String(path).includes("dev-worker.sh")) {
        return makeScriptContent("Work on tasks") as never;
      }
      throw new Error("ENOENT");
    });

    const config = makeConfig({
      workers: [
        {
          name: "dev-worker-1",
          label: "Dev Worker 1",
          category: "core",
          schedule: "On demand",
          description: "Worker one",
        },
      ],
    });

    const handler = createPromptsHandler(config);
    const res = await handler();
    const { data } = await res.json();

    expect(data).toHaveLength(1);
    expect(data[0].workerLabel).toBe("Dev Worker 1");
    expect(data[0].description).toBe("Worker one");
  });

  it("extracts multiple prompts from multiple scripts", async () => {
    mockReadFileSync.mockImplementation((path) => {
      const p = String(path);
      if (p.includes("dev-worker.sh"))
        return makeScriptContent("Dev prompt") as never;
      if (p.includes("health-check.sh"))
        return makeScriptContent("Health prompt") as never;
      throw new Error("ENOENT");
    });

    const handler = createPromptsHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();

    expect(data).toHaveLength(2);
    expect(data[0].scriptName).toBe("dev-worker");
    expect(data[0].prompt).toBe("Dev prompt");
    expect(data[1].scriptName).toBe("health-check");
    expect(data[1].prompt).toBe("Health prompt");
  });

  it("uses config.scriptsDir for script paths", async () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const handler = createPromptsHandler(
      makeConfig({ scriptsDir: "/custom/scripts" })
    );
    await handler();

    const calls = mockReadFileSync.mock.calls.map((c) => String(c[0]));
    const matchingCalls = calls.filter((c) =>
      c.startsWith("/custom/scripts/")
    );
    expect(matchingCalls.length).toBeGreaterThan(0);
  });

  it("response shape matches PromptTemplate interface", async () => {
    mockReadFileSync.mockImplementation((path) => {
      if (String(path).includes("dev-worker.sh"))
        return makeScriptContent("Test prompt") as never;
      throw new Error("ENOENT");
    });

    const handler = createPromptsHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();

    const prompt = data[0];
    expect(typeof prompt.scriptName).toBe("string");
    expect(typeof prompt.workerLabel).toBe("string");
    expect(typeof prompt.description).toBe("string");
    expect(["core", "testing", "infra", "data"]).toContain(prompt.category);
    expect(typeof prompt.prompt).toBe("string");
  });

  it("skips scripts with unclosed PROMPT quote", async () => {
    mockReadFileSync.mockImplementation((path) => {
      if (String(path).includes("dev-worker.sh"))
        return 'PROMPT="unclosed prompt value' as never;
      throw new Error("ENOENT");
    });

    const handler = createPromptsHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();

    expect(data).toHaveLength(0);
  });

  it("preserves worker category from config", async () => {
    mockReadFileSync.mockImplementation((path) => {
      if (String(path).includes("health-check.sh"))
        return makeScriptContent("Health prompt") as never;
      throw new Error("ENOENT");
    });

    const handler = createPromptsHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();

    expect(data).toHaveLength(1);
    expect(data[0].category).toBe("infra");
  });

  it("defaults to devDir/scripts when scriptsDir not set", async () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const handler = createPromptsHandler(
      makeConfig({ scriptsDir: undefined })
    );
    await handler();

    const calls = mockReadFileSync.mock.calls.map((c) => String(c[0]));
    const matchingCalls = calls.filter((c) =>
      c.startsWith("/tmp/test/.dev/scripts/")
    );
    expect(matchingCalls.length).toBeGreaterThan(0);
  });

  it("processes all six hardcoded script names", async () => {
    const expectedScripts = [
      "dev-worker",
      "task-fixer",
      "project-driver",
      "health-check",
      "ui-tester",
      "feature-validator",
    ];

    mockReadFileSync.mockImplementation((path) => {
      const p = String(path);
      for (const name of expectedScripts) {
        if (p.includes(`${name}.sh`))
          return makeScriptContent(`Prompt for ${name}`) as never;
      }
      throw new Error("ENOENT");
    });

    const handler = createPromptsHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();

    expect(data).toHaveLength(6);
    const scriptNames = data.map((d: { scriptName: string }) => d.scriptName);
    expect(scriptNames).toEqual(expectedScripts);
  });

  it("generates title-case fallback labels for multi-word script names", async () => {
    mockReadFileSync.mockImplementation((path) => {
      if (String(path).includes("feature-validator.sh"))
        return makeScriptContent("Validate features") as never;
      throw new Error("ENOENT");
    });

    const handler = createPromptsHandler(makeConfig({ workers: [] }));
    const res = await handler();
    const { data } = await res.json();

    expect(data).toHaveLength(1);
    expect(data[0].workerLabel).toBe("Feature Validator");
  });
});
