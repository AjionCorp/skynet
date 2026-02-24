import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseMissionCriteria, evaluateCriterion } from "./mission";

vi.mock("fs", () => ({
  existsSync: vi.fn(() => false),
  readdirSync: vi.fn(() => []),
}));

vi.mock("./file-reader", () => ({
  readDevFile: vi.fn(() => ""),
}));

import { existsSync, readdirSync } from "fs";
import { readDevFile } from "./file-reader";

const mockExistsSync = vi.mocked(existsSync);
const mockReaddirSync = vi.mocked(readdirSync);
const mockReadDevFile = vi.mocked(readDevFile);

function makeCtx(overrides?: Partial<Parameters<typeof evaluateCriterion>[2]>) {
  return {
    devDir: "/tmp/test/.dev",
    completedCount: 0,
    failedLines: [] as { status: string }[],
    handlerCount: 0,
    ...overrides,
  };
}

describe("parseMissionCriteria", () => {
  it("extracts numbered criteria from Success Criteria section", () => {
    const content = [
      "# Mission",
      "Some preamble.",
      "## Success Criteria",
      "1. First criterion",
      "2. Second criterion",
      "3. Third criterion",
      "## Other Section",
      "Stuff here.",
    ].join("\n");

    const result = parseMissionCriteria(content);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ id: 1, criterion: "First criterion" });
    expect(result[1]).toEqual({ id: 2, criterion: "Second criterion" });
    expect(result[2]).toEqual({ id: 3, criterion: "Third criterion" });
  });

  it("returns empty array when no Success Criteria section exists", () => {
    const content = "# Mission\nNo criteria here.\n## Other Heading\n";
    expect(parseMissionCriteria(content)).toEqual([]);
  });

  it("returns empty array for empty string", () => {
    expect(parseMissionCriteria("")).toEqual([]);
  });

  it("ignores non-numbered lines in Success Criteria section", () => {
    const content = [
      "## Success Criteria",
      "Some intro text",
      "1. Real criterion",
      "- Not a criterion",
      "2. Another criterion",
    ].join("\n");

    const result = parseMissionCriteria(content);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ id: 1, criterion: "Real criterion" });
    expect(result[1]).toEqual({ id: 2, criterion: "Another criterion" });
  });

  it("handles Success Criteria at end of file (no trailing section)", () => {
    const content = [
      "## Success Criteria",
      "1. Only criterion",
    ].join("\n");

    const result = parseMissionCriteria(content);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ id: 1, criterion: "Only criterion" });
  });
});

describe("evaluateCriterion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadDevFile.mockReturnValue("");
  });

  describe("case 1: Zero-to-autonomous setup", () => {
    it("returns 'met' when handlerCount >= 5", () => {
      const result = evaluateCriterion(1, "setup criterion", makeCtx({ handlerCount: 5 }));
      expect(result.status).toBe("met");
      expect(result.evidence).toContain("5");
    });

    it("returns 'partial' when handlerCount < 5", () => {
      const result = evaluateCriterion(1, "setup criterion", makeCtx({ handlerCount: 3 }));
      expect(result.status).toBe("partial");
      expect(result.evidence).toContain("3");
    });
  });

  describe("case 2: Self-correction rate", () => {
    it("returns 'met' when fix rate >= 95%", () => {
      const failedLines = [
        ...Array(19).fill({ status: "fixed" }),
        { status: "blocked" },
      ];
      const result = evaluateCriterion(2, "self-correction", makeCtx({ failedLines }));
      expect(result.status).toBe("met");
      expect(result.evidence).toContain("95%");
    });

    it("returns 'partial' when fix rate >= 50% but < 95%", () => {
      const failedLines = [
        { status: "fixed" },
        { status: "blocked" },
      ];
      const result = evaluateCriterion(2, "self-correction", makeCtx({ failedLines }));
      expect(result.status).toBe("partial");
      expect(result.evidence).toContain("50%");
    });

    it("returns 'not-met' when fix rate < 50%", () => {
      const failedLines = [
        { status: "fixed" },
        { status: "blocked" },
        { status: "blocked" },
        { status: "blocked" },
      ];
      const result = evaluateCriterion(2, "self-correction", makeCtx({ failedLines }));
      expect(result.status).toBe("not-met");
      expect(result.evidence).toContain("25%");
    });

    it("returns 'partial' when no failed tasks resolved yet", () => {
      const result = evaluateCriterion(2, "self-correction", makeCtx({ failedLines: [] }));
      expect(result.status).toBe("partial");
      expect(result.evidence).toContain("No failed tasks resolved");
    });

    it("counts superseded as self-corrected", () => {
      const failedLines = [
        ...Array(10).fill({ status: "superseded" }),
      ];
      const result = evaluateCriterion(2, "self-correction", makeCtx({ failedLines }));
      expect(result.status).toBe("met");
      expect(result.evidence).toContain("100%");
    });
  });

  describe("case 3: No zombies/deadlocks", () => {
    it("returns 'met' when no zombie/deadlock references in logs", () => {
      mockReadDevFile.mockReturnValue("all good, no issues");
      const result = evaluateCriterion(3, "no zombies", makeCtx());
      expect(result.status).toBe("met");
    });

    it("returns 'partial' when 1-3 references found", () => {
      mockReadDevFile.mockReturnValue("zombie detected\nzombie found\ndeadlock issue");
      const result = evaluateCriterion(3, "no zombies", makeCtx());
      expect(result.status).toBe("partial");
      expect(result.evidence).toContain("3");
    });

    it("returns 'not-met' when >3 references found", () => {
      mockReadDevFile.mockReturnValue("zombie 1\nzombie 2\nzombie 3\ndeadlock 4");
      const result = evaluateCriterion(3, "no zombies", makeCtx());
      expect(result.status).toBe("not-met");
      expect(result.evidence).toContain("4");
    });
  });

  describe("case 4: Dashboard visibility", () => {
    it("returns 'met' when handlerCount >= 8", () => {
      const result = evaluateCriterion(4, "dashboard", makeCtx({ handlerCount: 10 }));
      expect(result.status).toBe("met");
    });

    it("returns 'partial' when handlerCount >= 5 and < 8", () => {
      const result = evaluateCriterion(4, "dashboard", makeCtx({ handlerCount: 6 }));
      expect(result.status).toBe("partial");
    });

    it("returns 'not-met' when handlerCount < 5", () => {
      const result = evaluateCriterion(4, "dashboard", makeCtx({ handlerCount: 3 }));
      expect(result.status).toBe("not-met");
    });
  });

  describe("case 5: Measurable progress", () => {
    it("returns 'met' when completedCount >= 10", () => {
      const result = evaluateCriterion(5, "progress", makeCtx({ completedCount: 15 }));
      expect(result.status).toBe("met");
    });

    it("returns 'partial' when completedCount >= 3 and < 10", () => {
      const result = evaluateCriterion(5, "progress", makeCtx({ completedCount: 5 }));
      expect(result.status).toBe("partial");
    });

    it("returns 'not-met' when completedCount < 3", () => {
      const result = evaluateCriterion(5, "progress", makeCtx({ completedCount: 1 }));
      expect(result.status).toBe("not-met");
    });
  });

  describe("case 6: Multi-agent support", () => {
    it("returns 'met' when >= 2 agent plugins exist", () => {
      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockReturnValue(["claude.sh", "codex.sh"] as unknown as ReturnType<typeof readdirSync>);
      const result = evaluateCriterion(6, "multi-agent", makeCtx());
      expect(result.status).toBe("met");
      expect(result.evidence).toContain("2 agent plugins");
    });

    it("returns 'partial' when exactly 1 agent plugin exists", () => {
      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockReturnValue(["claude.sh"] as unknown as ReturnType<typeof readdirSync>);
      const result = evaluateCriterion(6, "multi-agent", makeCtx());
      expect(result.status).toBe("partial");
    });

    it("returns 'not-met' when no agent plugins directory exists", () => {
      mockExistsSync.mockReturnValue(false);
      const result = evaluateCriterion(6, "multi-agent", makeCtx());
      expect(result.status).toBe("not-met");
      expect(result.evidence).toContain("No agent plugins");
    });

    it("returns 'not-met' when agents dir exists but has no .sh files", () => {
      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockReturnValue(["readme.txt"] as unknown as ReturnType<typeof readdirSync>);
      const result = evaluateCriterion(6, "multi-agent", makeCtx());
      expect(result.status).toBe("not-met");
    });
  });

  describe("default case", () => {
    it("returns 'not-met' for unknown criterion IDs", () => {
      const result = evaluateCriterion(99, "unknown thing", makeCtx());
      expect(result.status).toBe("not-met");
      expect(result.evidence).toContain("Unknown criterion");
    });

    it("returns 'not-met' for criterion ID 0", () => {
      const result = evaluateCriterion(0, "zero id", makeCtx());
      expect(result.status).toBe("not-met");
    });
  });
});
