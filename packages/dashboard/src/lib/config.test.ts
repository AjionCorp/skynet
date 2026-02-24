import { describe, it, expect } from "vitest";
import { createConfig, DEFAULT_WORKERS } from "./config";

describe("createConfig", () => {
  const base = { projectName: "test", devDir: "/tmp/.dev", lockPrefix: "/tmp/skynet-test" };

  it("creates config with defaults", () => {
    const config = createConfig(base);
    expect(config.projectName).toBe("test");
    expect(config.workers).toBe(DEFAULT_WORKERS);
    expect(config.taskTags).toContain("FEAT");
    expect(config.taskTags).toContain("FIX");
    expect(config.triggerableScripts).toContain("dev-worker");
  });

  it("allows overriding workers", () => {
    const custom = [{ name: "w1", label: "Worker 1", schedule: "1m", description: "test" }];
    const config = createConfig({ ...base, workers: custom });
    expect(config.workers).toBe(custom);
  });

  it("allows overriding taskTags", () => {
    const config = createConfig({ ...base, taskTags: ["A", "B"] });
    expect(config.taskTags).toEqual(["A", "B"]);
  });

  it("preserves extra overrides", () => {
    const config = createConfig({ ...base, maxWorkers: 8 });
    expect(config.maxWorkers).toBe(8);
  });

  it("includes all default worker definitions", () => {
    expect(DEFAULT_WORKERS.length).toBeGreaterThanOrEqual(10);
    const names = DEFAULT_WORKERS.map(w => w.name);
    expect(names).toContain("dev-worker-1");
    expect(names).toContain("task-fixer");
    expect(names).toContain("watchdog");
  });
});
