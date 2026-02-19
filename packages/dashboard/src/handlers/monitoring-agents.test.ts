import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMonitoringAgentsHandler } from "./monitoring-agents";
import type { SkynetConfig } from "../types";

vi.mock("fs", () => ({
  readFileSync: vi.fn(() => ""),
  existsSync: vi.fn(() => false),
}));

vi.mock("child_process", () => ({
  execSync: vi.fn(() => ""),
}));

vi.mock("os", () => ({
  homedir: vi.fn(() => "/Users/testuser"),
}));

import { readFileSync, existsSync } from "fs";
import { execSync } from "child_process";

const mockReadFileSync = vi.mocked(readFileSync);
const mockExistsSync = vi.mocked(existsSync);
const mockExecSync = vi.mocked(execSync);

function makeConfig(overrides?: Partial<SkynetConfig>): SkynetConfig {
  return {
    projectName: "test-project",
    devDir: "/tmp/test/.dev",
    lockPrefix: "/tmp/skynet-test-",
    agentPrefix: "com.test-project",
    workers: [
      {
        name: "dev-worker-1",
        label: "Dev Worker 1",
        category: "core",
        schedule: "On demand",
        description: "Implements tasks",
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

function makePlist(opts: {
  interval?: number;
  runAtLoad?: boolean;
  script?: string;
  logPath?: string;
}): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    "  <string>com.test-project.dev-worker-1</string>",
    opts.interval != null
      ? "  <key>StartInterval</key>\n  <integer>" + opts.interval + "</integer>"
      : "",
    opts.runAtLoad != null
      ? "  <key>RunAtLoad</key>\n  <" + opts.runAtLoad + " />"
      : "",
    opts.script
      ? "  <key>ProgramArguments</key>\n  <array>\n    <string>/bin/bash</string>\n    <string>/path/.dev/scripts/" + opts.script + "</string>\n  </array>"
      : "",
    opts.logPath
      ? "  <key>StandardOutPath</key>\n  <string>" + opts.logPath + "</string>"
      : "",
    "</dict>",
    "</plist>",
  ]
    .filter(Boolean)
    .join("\n");
}

describe("createMonitoringAgentsHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecSync.mockReturnValue("" as never);
    mockExistsSync.mockReturnValue(false);
  });

  it("returns { data: { agents }, error: null } envelope", async () => {
    const handler = createMonitoringAgentsHandler(makeConfig());
    const res = await handler();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.error).toBeNull();
    expect(body.data).toHaveProperty("agents");
    expect(Array.isArray(body.data.agents)).toBe(true);
  });

  it("returns one agent entry per worker in config", async () => {
    const handler = createMonitoringAgentsHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();

    expect(data.agents).toHaveLength(2);
    expect(data.agents[0].label).toBe("com.test-project.dev-worker-1");
    expect(data.agents[0].name).toBe("Dev Worker 1");
    expect(data.agents[1].label).toBe("com.test-project.health-check");
    expect(data.agents[1].name).toBe("Health Check");
  });

  it("marks agents as not loaded when not in launchctl output", async () => {
    mockExecSync.mockReturnValue("PID\tStatus\tLabel\n" as never);

    const handler = createMonitoringAgentsHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();

    for (const agent of data.agents) {
      expect(agent.loaded).toBe(false);
      expect(agent.lastExitStatus).toBeNull();
      expect(agent.pid).toBeNull();
    }
  });

  it("parses launchctl output for loaded agents", async () => {
    mockExecSync.mockReturnValue(
      [
        "PID\tStatus\tLabel",
        "1234\t0\tcom.test-project.dev-worker-1",
        "-\t78\tcom.test-project.health-check",
      ].join("\n") as never
    );

    const handler = createMonitoringAgentsHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();

    const devWorker = data.agents[0];
    expect(devWorker.loaded).toBe(true);
    expect(devWorker.pid).toBe("1234");
    expect(devWorker.lastExitStatus).toBe(0);

    const healthCheck = data.agents[1];
    expect(healthCheck.loaded).toBe(true);
    expect(healthCheck.pid).toBeNull();
    expect(healthCheck.lastExitStatus).toBe(78);
  });

  it("parses plist file for interval, runAtLoad, scriptPath, logPath", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      makePlist({
        interval: 1800,
        runAtLoad: true,
        script: "dev-worker-1.sh",
        logPath: "/tmp/dev-worker-1.log",
      }) as never
    );

    const handler = createMonitoringAgentsHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();

    const agent = data.agents[0];
    expect(agent.plistExists).toBe(true);
    expect(agent.interval).toBe(1800);
    expect(agent.intervalHuman).toBe("30 min");
    expect(agent.runAtLoad).toBe(true);
    expect(agent.scriptPath).toBe("dev-worker-1.sh");
    expect(agent.logPath).toBe("/tmp/dev-worker-1.log");
  });

  it("handles plist not existing gracefully", async () => {
    mockExistsSync.mockReturnValue(false);

    const handler = createMonitoringAgentsHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();

    const agent = data.agents[0];
    expect(agent.plistExists).toBe(false);
    expect(agent.interval).toBeNull();
    expect(agent.intervalHuman).toBeNull();
    expect(agent.runAtLoad).toBe(false);
    expect(agent.scriptPath).toBeNull();
    expect(agent.logPath).toBeNull();
  });

  it("formats intervalHuman for various durations", async () => {
    const testCases = [
      { interval: 30, expected: "30s" },
      { interval: 300, expected: "5 min" },
      { interval: 3600, expected: "1 hour" },
      { interval: 7200, expected: "2 hours" },
      { interval: 86400, expected: "1 day" },
      { interval: 259200, expected: "3 days" },
    ];

    for (const tc of testCases) {
      vi.clearAllMocks();
      mockExistsSync.mockReturnValue(true);
      mockExecSync.mockReturnValue("" as never);
      mockReadFileSync.mockReturnValue(
        makePlist({ interval: tc.interval }) as never
      );

      const config = makeConfig({
        workers: [
          {
            name: "test-worker",
            label: "Test",
            schedule: "test",
            description: "test",
          },
        ],
      });
      const handler = createMonitoringAgentsHandler(config);
      const res = await handler();
      const { data } = await res.json();

      expect(data.agents[0].intervalHuman).toBe(tc.expected);
    }
  });

  it("uses default agentPrefix from projectName when not configured", async () => {
    const config = makeConfig({ agentPrefix: undefined });
    const handler = createMonitoringAgentsHandler(config);
    const res = await handler();
    const { data } = await res.json();

    expect(data.agents[0].label).toBe("com.test-project.dev-worker-1");
  });

  it("response agents match AgentInfo interface shape", async () => {
    mockExecSync.mockReturnValue(
      "1234\t0\tcom.test-project.dev-worker-1\n" as never
    );
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      makePlist({ interval: 300, runAtLoad: true }) as never
    );

    const handler = createMonitoringAgentsHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();

    const agent = data.agents[0];

    expect(typeof agent.label).toBe("string");
    expect(typeof agent.name).toBe("string");
    expect(typeof agent.loaded).toBe("boolean");
    expect(
      agent.lastExitStatus === null || typeof agent.lastExitStatus === "number"
    ).toBe(true);
    expect(agent.pid === null || typeof agent.pid === "string").toBe(true);
    expect(typeof agent.plistExists).toBe("boolean");
    expect(
      agent.interval === null || typeof agent.interval === "number"
    ).toBe(true);
    expect(
      agent.intervalHuman === null || typeof agent.intervalHuman === "string"
    ).toBe(true);
    expect(typeof agent.runAtLoad).toBe("boolean");
    expect(
      agent.scriptPath === null || typeof agent.scriptPath === "string"
    ).toBe(true);
    expect(
      agent.logPath === null || typeof agent.logPath === "string"
    ).toBe(true);
  });

  it("returns 500 with error when handler throws", async () => {
    const config = makeConfig();
    mockExecSync.mockImplementation(() => {
      throw new Error("launchctl not found");
    });
    mockExistsSync.mockImplementation(() => {
      throw new Error("Permission denied");
    });

    const handler = createMonitoringAgentsHandler(config);
    const res = await handler();
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.data).toBeNull();
    expect(typeof body.error).toBe("string");
  });

  it("gracefully handles launchctl failure", async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("launchctl: operation not permitted");
    });

    const handler = createMonitoringAgentsHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();

    expect(res.status).toBe(200);
    expect(data.agents).toHaveLength(2);
    for (const agent of data.agents) {
      expect(agent.loaded).toBe(false);
    }
  });
});
