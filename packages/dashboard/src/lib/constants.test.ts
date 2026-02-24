import { describe, it, expect } from "vitest";
import { STALE_THRESHOLD_SECONDS, SAFE_SCRIPT_NAME, SAFE_SCRIPT_PATH, SAFE_AGENT_NAME, VALID_CONFIG_KEY } from "./constants";

describe("constants", () => {
  describe("STALE_THRESHOLD_SECONDS", () => {
    it("is 30 minutes", () => {
      expect(STALE_THRESHOLD_SECONDS).toBe(1800);
    });
  });

  describe("SAFE_SCRIPT_NAME", () => {
    it("accepts valid names", () => {
      expect(SAFE_SCRIPT_NAME.test("dev-worker")).toBe(true);
      expect(SAFE_SCRIPT_NAME.test("task-fixer-2")).toBe(true);
      expect(SAFE_SCRIPT_NAME.test("watchdog")).toBe(true);
    });
    it("rejects invalid names", () => {
      expect(SAFE_SCRIPT_NAME.test("../bad")).toBe(false);
      expect(SAFE_SCRIPT_NAME.test("has space")).toBe(false);
      expect(SAFE_SCRIPT_NAME.test("UPPER")).toBe(false);
      expect(SAFE_SCRIPT_NAME.test("")).toBe(false);
    });
  });

  describe("SAFE_SCRIPT_PATH", () => {
    it("accepts valid paths", () => {
      expect(SAFE_SCRIPT_PATH.test("watchdog.sh")).toBe(true);
      expect(SAFE_SCRIPT_PATH.test("my_script-v2.sh")).toBe(true);
    });
    it("rejects traversal", () => {
      expect(SAFE_SCRIPT_PATH.test("../etc/passwd")).toBe(false);
      expect(SAFE_SCRIPT_PATH.test("/absolute")).toBe(false);
    });
  });

  describe("SAFE_AGENT_NAME", () => {
    it("accepts valid agent names", () => {
      expect(SAFE_AGENT_NAME.test("watchdog")).toBe(true);
      expect(SAFE_AGENT_NAME.test("dev-worker-1")).toBe(true);
      expect(SAFE_AGENT_NAME.test("task_fixer")).toBe(true);
    });
    it("rejects invalid agent names", () => {
      expect(SAFE_AGENT_NAME.test("has space")).toBe(false);
      expect(SAFE_AGENT_NAME.test("path/traversal")).toBe(false);
    });
  });

  describe("VALID_CONFIG_KEY", () => {
    it("accepts valid config keys", () => {
      expect(VALID_CONFIG_KEY.test("SKYNET_MAX_WORKERS")).toBe(true);
      expect(VALID_CONFIG_KEY.test("_INTERNAL")).toBe(true);
    });
    it("rejects invalid keys", () => {
      expect(VALID_CONFIG_KEY.test("lowercase")).toBe(false);
      expect(VALID_CONFIG_KEY.test("123START")).toBe(false);
      expect(VALID_CONFIG_KEY.test("HAS-DASH")).toBe(false);
    });
  });
});
