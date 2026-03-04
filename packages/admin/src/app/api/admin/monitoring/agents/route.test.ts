import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock fs — the agents handler reads plist files
vi.mock("fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ""),
}));

// Mock child_process — launchctl list
vi.mock("child_process", () => ({
  spawnSync: vi.fn(() => ({ stdout: "", stderr: "", status: 0 })),
}));

// Mock os — platform detection and homedir
vi.mock("os", () => ({
  platform: vi.fn(() => "darwin"),
  homedir: vi.fn(() => "/Users/testuser"),
}));

// Provide controlled config
vi.mock("../../../../../lib/skynet-config", () => ({
  config: {
    projectName: "test-project",
    devDir: "/tmp/test/.dev",
    lockPrefix: "/tmp/skynet-test",
    workers: [
      { name: "watchdog", label: "Watchdog", category: "core", schedule: "Every 5 min", description: "Dispatches workers" },
      { name: "dev-worker-1", label: "Dev Worker 1", category: "core", schedule: "On demand", description: "Implements tasks" },
    ],
    triggerableScripts: [],
    taskTags: ["FEAT", "FIX"],
  },
}));

import { GET, dynamic } from "./route";
import { existsSync, readFileSync } from "fs";
import { spawnSync } from "child_process";

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockSpawnSync = vi.mocked(spawnSync);

describe("/api/admin/monitoring/agents route integration", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.NODE_ENV = "development";
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockReturnValue("" as never);
    mockSpawnSync.mockReturnValue({ stdout: "", stderr: "", status: 0 } as never);
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it("exports force-dynamic to disable Next.js response caching", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  it("returns { data, error: null } envelope on success", async () => {
    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toHaveProperty("data");
    expect(body).toHaveProperty("error");
    expect(body.error).toBeNull();
  });

  it("returns agents array matching worker config count", async () => {
    const res = await GET();
    const { data } = await res.json();

    expect(data.agents).toHaveLength(2);
    expect(data.agents[0].name).toBe("Watchdog");
    expect(data.agents[1].name).toBe("Dev Worker 1");
  });

  it("returns unloaded agents when launchctl shows no matches", async () => {
    const res = await GET();
    const { data } = await res.json();

    expect(data.agents[0].loaded).toBe(false);
    expect(data.agents[0].plistExists).toBe(false);
    expect(data.agents[0].pid).toBeNull();
  });

  it("detects loaded agent from launchctl output", async () => {
    // Simulate launchctl list showing the agents
    mockSpawnSync.mockReturnValue({
      stdout: "-\t0\tcom.test-project.watchdog\n42\t0\tcom.test-project.dev-worker-1\n",
      stderr: "",
      status: 0,
    } as never);

    const res = await GET();
    const { data } = await res.json();

    expect(data.agents[0].loaded).toBe(true);
    expect(data.agents[0].lastExitStatus).toBe(0);
    expect(data.agents[0].pid).toBeNull(); // PID is "-"
    expect(data.agents[1].loaded).toBe(true);
    expect(data.agents[1].pid).toBe("42");
  });

  it("parses plist interval and runAtLoad when plist file exists", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue([
      '<?xml version="1.0"?>',
      "<plist>",
      "<dict>",
      "<key>StartInterval</key>",
      "<integer>300</integer>",
      "<key>RunAtLoad</key>",
      "<true />",
      '<key>ProgramArguments</key><string>.dev/scripts/watchdog.sh</string>',
      "<key>StandardOutPath</key>",
      "<string>/Users/testuser/.dev/scripts/watchdog.log</string>",
      "</dict>",
      "</plist>",
    ].join("\n") as never);

    const res = await GET();
    const { data } = await res.json();

    expect(data.agents[0].interval).toBe(300);
    expect(data.agents[0].intervalHuman).toBe("5 min");
    expect(data.agents[0].runAtLoad).toBe(true);
    expect(data.agents[0].scriptPath).toBe("watchdog.sh");
  });

  it("returns agent labels with correct prefix from config", async () => {
    const res = await GET();
    const { data } = await res.json();

    expect(data.agents[0].label).toBe("com.test-project.watchdog");
    expect(data.agents[1].label).toBe("com.test-project.dev-worker-1");
  });
});
