import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { resolve } from "path";

// Capture calls to createConfig by mocking the dashboard package
const mockCreateConfig = vi.fn((overrides: Record<string, unknown>) => ({
  projectName: "mocked",
  devDir: "/mocked",
  lockPrefix: "/mocked",
  workers: [],
  triggerableScripts: [],
  taskTags: [],
  ...overrides,
}));

vi.mock("@ajioncorp/skynet", () => ({
  createConfig: mockCreateConfig,
}));

// Save original env so we can restore after all tests
const originalEnv = { ...process.env };

async function loadConfig() {
  vi.resetModules();
  const mod = await import("./skynet-config");
  return mod.config;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Strip all SKYNET_ env vars so each test starts clean
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("SKYNET_")) {
      delete process.env[key];
    }
  }
});

afterAll(() => {
  process.env = originalEnv;
});

describe("skynet-config", () => {
  describe("default values (no env vars)", () => {
    it("uses 'skynet' as the default project name", async () => {
      await loadConfig();
      const args = mockCreateConfig.mock.calls[0][0];
      expect(args.projectName).toBe("skynet");
    });

    it("derives devDir from cwd-based repo root", async () => {
      await loadConfig();
      const args = mockCreateConfig.mock.calls[0][0];
      const expectedRoot = resolve(process.cwd(), "../..");
      expect(args.devDir).toBe(resolve(expectedRoot, ".dev"));
    });

    it("derives lockPrefix from default project name", async () => {
      await loadConfig();
      const args = mockCreateConfig.mock.calls[0][0];
      expect(args.lockPrefix).toBe("/tmp/skynet-skynet");
    });

    it("derives scriptsDir from cwd-based repo root", async () => {
      await loadConfig();
      const args = mockCreateConfig.mock.calls[0][0];
      const expectedRoot = resolve(process.cwd(), "../..");
      expect(args.scriptsDir).toBe(resolve(expectedRoot, "scripts"));
    });

    it("does not set maxFixers when env var is absent", async () => {
      await loadConfig();
      const args = mockCreateConfig.mock.calls[0][0];
      expect(args.maxFixers).toBeUndefined();
    });
  });

  describe("SKYNET_PROJECT_DIR", () => {
    it("overrides repo root when set", async () => {
      process.env.SKYNET_PROJECT_DIR = "/custom/project";
      await loadConfig();
      const args = mockCreateConfig.mock.calls[0][0];
      expect(args.devDir).toBe(resolve("/custom/project", ".dev"));
      expect(args.scriptsDir).toBe(resolve("/custom/project", "scripts"));
    });
  });

  describe("SKYNET_DEV_DIR", () => {
    it("overrides devDir when set", async () => {
      process.env.SKYNET_DEV_DIR = "/override/dev";
      await loadConfig();
      const args = mockCreateConfig.mock.calls[0][0];
      expect(args.devDir).toBe("/override/dev");
    });

    it("takes precedence over SKYNET_PROJECT_DIR for devDir", async () => {
      process.env.SKYNET_PROJECT_DIR = "/custom/project";
      process.env.SKYNET_DEV_DIR = "/override/dev";
      await loadConfig();
      const args = mockCreateConfig.mock.calls[0][0];
      expect(args.devDir).toBe("/override/dev");
      // scriptsDir still derived from SKYNET_PROJECT_DIR
      expect(args.scriptsDir).toBe(resolve("/custom/project", "scripts"));
    });
  });

  describe("SKYNET_PROJECT_NAME", () => {
    it("overrides project name when set", async () => {
      process.env.SKYNET_PROJECT_NAME = "my-app";
      await loadConfig();
      const args = mockCreateConfig.mock.calls[0][0];
      expect(args.projectName).toBe("my-app");
    });

    it("affects default lockPrefix when SKYNET_LOCK_PREFIX is not set", async () => {
      process.env.SKYNET_PROJECT_NAME = "my-app";
      await loadConfig();
      const args = mockCreateConfig.mock.calls[0][0];
      expect(args.lockPrefix).toBe("/tmp/skynet-my-app");
    });
  });

  describe("SKYNET_LOCK_PREFIX", () => {
    it("overrides lockPrefix when set", async () => {
      process.env.SKYNET_LOCK_PREFIX = "/var/locks/custom";
      await loadConfig();
      const args = mockCreateConfig.mock.calls[0][0];
      expect(args.lockPrefix).toBe("/var/locks/custom");
    });

    it("takes precedence over project-name-derived prefix", async () => {
      process.env.SKYNET_PROJECT_NAME = "my-app";
      process.env.SKYNET_LOCK_PREFIX = "/var/locks/custom";
      await loadConfig();
      const args = mockCreateConfig.mock.calls[0][0];
      expect(args.lockPrefix).toBe("/var/locks/custom");
    });
  });

  describe("SKYNET_MAX_FIXERS", () => {
    it("passes valid positive integer", async () => {
      process.env.SKYNET_MAX_FIXERS = "5";
      await loadConfig();
      const args = mockCreateConfig.mock.calls[0][0];
      expect(args.maxFixers).toBe(5);
    });

    it("passes undefined for zero", async () => {
      process.env.SKYNET_MAX_FIXERS = "0";
      await loadConfig();
      const args = mockCreateConfig.mock.calls[0][0];
      expect(args.maxFixers).toBeUndefined();
    });

    it("passes undefined for negative number", async () => {
      process.env.SKYNET_MAX_FIXERS = "-3";
      await loadConfig();
      const args = mockCreateConfig.mock.calls[0][0];
      expect(args.maxFixers).toBeUndefined();
    });

    it("passes undefined for non-numeric string", async () => {
      process.env.SKYNET_MAX_FIXERS = "abc";
      await loadConfig();
      const args = mockCreateConfig.mock.calls[0][0];
      expect(args.maxFixers).toBeUndefined();
    });

    it("passes undefined for empty string", async () => {
      process.env.SKYNET_MAX_FIXERS = "";
      await loadConfig();
      const args = mockCreateConfig.mock.calls[0][0];
      expect(args.maxFixers).toBeUndefined();
    });

    it("handles float values (Number coercion)", async () => {
      process.env.SKYNET_MAX_FIXERS = "2.7";
      await loadConfig();
      const args = mockCreateConfig.mock.calls[0][0];
      expect(args.maxFixers).toBe(2.7);
    });
  });

  describe("createConfig integration", () => {
    it("calls createConfig exactly once per import", async () => {
      await loadConfig();
      expect(mockCreateConfig).toHaveBeenCalledTimes(1);
    });

    it("passes all required fields to createConfig", async () => {
      process.env.SKYNET_PROJECT_NAME = "test-proj";
      process.env.SKYNET_DEV_DIR = "/test/dev";
      process.env.SKYNET_LOCK_PREFIX = "/test/lock";
      process.env.SKYNET_PROJECT_DIR = "/test/root";
      process.env.SKYNET_MAX_FIXERS = "2";
      await loadConfig();
      const args = mockCreateConfig.mock.calls[0][0];
      expect(args).toMatchObject({
        projectName: "test-proj",
        devDir: "/test/dev",
        lockPrefix: "/test/lock",
        scriptsDir: resolve("/test/root", "scripts"),
        maxFixers: 2,
      });
    });
  });
});
