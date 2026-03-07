import { describe, expect, it } from "vitest";
import { getWorkerTriggerSpec } from "./worker-triggers";

describe("getWorkerTriggerSpec", () => {
  it("maps numbered dev workers to the shared script with an ordinal argument", () => {
    expect(getWorkerTriggerSpec("dev-worker-3")).toEqual({
      script: "dev-worker",
      args: ["3"],
    });
  });

  it("maps numbered task fixers to the shared script with an ordinal argument", () => {
    expect(getWorkerTriggerSpec("task-fixer-2")).toEqual({
      script: "task-fixer",
      args: ["2"],
    });
  });

  it("keeps the primary task fixer triggerable without arguments", () => {
    expect(getWorkerTriggerSpec("task-fixer")).toEqual({
      script: "task-fixer",
      args: [],
    });
  });

  it("keeps direct trigger workers triggerable", () => {
    expect(getWorkerTriggerSpec("project-driver")).toEqual({
      script: "project-driver",
      args: [],
    });
    expect(getWorkerTriggerSpec("health-check")).toEqual({
      script: "health-check",
      args: [],
    });
  });

  it("returns null for workers that the trigger API does not accept", () => {
    expect(getWorkerTriggerSpec("watchdog")).toBeNull();
    expect(getWorkerTriggerSpec("auth-refresh")).toBeNull();
    expect(getWorkerTriggerSpec("codex-auth-refresh")).toBeNull();
  });
});
