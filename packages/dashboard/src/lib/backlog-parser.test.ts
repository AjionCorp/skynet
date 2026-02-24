import { describe, it, expect } from "vitest";
import {
  extractTitle,
  parseBlockedBy,
  parseBacklog,
  backlogCounts,
  parseBacklogWithBlocked,
} from "./backlog-parser";

describe("extractTitle", () => {
  it("strips tag prefix", () => {
    expect(extractTitle("[INFRA] Add WAL checkpoint")).toBe("Add WAL checkpoint");
  });

  it("strips description after em-dash", () => {
    expect(extractTitle("[TEST] Write unit tests — cover all edge cases")).toBe(
      "Write unit tests"
    );
  });

  it("truncates at 60 characters", () => {
    const longTitle =
      "This is a very long task title that exceeds sixty characters in total length by quite a bit";
    expect(extractTitle(longTitle).length).toBeLessThanOrEqual(60);
  });

  it("strips blockedBy metadata", () => {
    expect(
      extractTitle("[DATA] Surface counters | blockedBy: Add WAL checkpoint")
    ).toBe("Surface counters");
  });

  it("handles title with no tag", () => {
    expect(extractTitle("Simple task")).toBe("Simple task");
  });

  it("handles empty string", () => {
    expect(extractTitle("")).toBe("");
  });

  it("handles tag only", () => {
    expect(extractTitle("[TAG] ")).toBe("");
  });

  it("strips both tag and description and blockedBy", () => {
    expect(
      extractTitle("[FIX] Repair auth — token refresh logic | blockedBy: dep1, dep2")
    ).toBe("Repair auth");
  });
});

describe("parseBlockedBy", () => {
  it("extracts comma-separated deps", () => {
    expect(
      parseBlockedBy("Some task | blockedBy: dep1, dep2, dep3")
    ).toEqual(["dep1", "dep2", "dep3"]);
  });

  it("returns empty array for no blockedBy", () => {
    expect(parseBlockedBy("Some task with no deps")).toEqual([]);
  });

  it("handles single dependency", () => {
    expect(parseBlockedBy("Task | blockedBy: single-dep")).toEqual([
      "single-dep",
    ]);
  });

  it("trims whitespace from deps", () => {
    expect(
      parseBlockedBy("Task | blockedBy:  dep1 ,  dep2 ")
    ).toEqual(["dep1", "dep2"]);
  });

  it("filters empty entries from trailing comma", () => {
    expect(parseBlockedBy("Task | blockedBy: dep1,")).toEqual(["dep1"]);
  });
});

describe("parseBacklog", () => {
  const sampleBacklog = `# Backlog

- [ ] [INFRA] Pending task — some description
- [>] [DATA] Claimed task
- [x] [TEST] Done task
- [ ] [FIX] Blocked task | blockedBy: Done task

Some random text that should be skipped
`;

  it("parses pending items", () => {
    const items = parseBacklog(sampleBacklog);
    const pending = items.filter((i) => i.status === "pending");
    expect(pending).toHaveLength(2);
  });

  it("parses claimed items", () => {
    const items = parseBacklog(sampleBacklog);
    const claimed = items.filter((i) => i.status === "claimed");
    expect(claimed).toHaveLength(1);
    expect(claimed[0].tag).toBe("DATA");
  });

  it("parses done items", () => {
    const items = parseBacklog(sampleBacklog);
    const done = items.filter((i) => i.status === "done");
    expect(done).toHaveLength(1);
    expect(done[0].tag).toBe("TEST");
  });

  it("skips non-task lines (headers, blank)", () => {
    const items = parseBacklog(sampleBacklog);
    expect(items).toHaveLength(4);
  });

  it("extracts tags", () => {
    const items = parseBacklog(sampleBacklog);
    expect(items[0].tag).toBe("INFRA");
  });

  it("extracts titles", () => {
    const items = parseBacklog(sampleBacklog);
    expect(items[0].title).toBe("Pending task");
  });

  it("extracts descriptions", () => {
    const items = parseBacklog(sampleBacklog);
    expect(items[0].description).toBe("some description");
  });

  it("extracts blockedBy", () => {
    const items = parseBacklog(sampleBacklog);
    const blocked = items.find((i) => i.title === "Blocked task");
    expect(blocked?.blockedBy).toEqual(["Done task"]);
  });

  it("returns null description when none present", () => {
    const items = parseBacklog("- [>] [DATA] Claimed task");
    expect(items[0].description).toBeNull();
  });

  it("handles empty string input", () => {
    expect(parseBacklog("")).toEqual([]);
  });

  it("handles malformed lines gracefully", () => {
    const items = parseBacklog("- [] broken\n- [ ] valid task");
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("valid task");
  });

  it("handles very long titles by not crashing", () => {
    const longLine = "- [ ] [TAG] " + "A".repeat(200);
    const items = parseBacklog(longLine);
    expect(items).toHaveLength(1);
    expect(items[0].title.length).toBe(200);
  });
});

describe("backlogCounts", () => {
  it("counts by status correctly", () => {
    const items = parseBacklog(
      "- [ ] pending1\n- [ ] pending2\n- [>] claimed1\n- [x] done1\n- [x] done2\n- [x] done3"
    );
    const counts = backlogCounts(items);
    expect(counts.pendingCount).toBe(2);
    expect(counts.claimedCount).toBe(1);
    expect(counts.doneCount).toBe(3);
  });

  it("returns zeros for empty array", () => {
    const counts = backlogCounts([]);
    expect(counts.pendingCount).toBe(0);
    expect(counts.claimedCount).toBe(0);
    expect(counts.doneCount).toBe(0);
  });
});

describe("parseBacklogWithBlocked", () => {
  it("resolves blocked status when dependency not done", () => {
    const content =
      "- [ ] TaskA | blockedBy: TaskB\n- [ ] TaskB";
    const result = parseBacklogWithBlocked(content);
    const taskA = result.items.find((i) => i.text.includes("TaskA"));
    expect(taskA?.blocked).toBe(true);
  });

  it("resolves unblocked when dependency is done", () => {
    const content =
      "- [ ] TaskA | blockedBy: TaskB\n- [x] TaskB";
    const result = parseBacklogWithBlocked(content);
    const taskA = result.items.find((i) => i.text.includes("TaskA"));
    expect(taskA?.blocked).toBe(false);
  });

  it("marks blocked when dependency is unknown (not in backlog)", () => {
    const content = "- [ ] TaskA | blockedBy: NonexistentTask";
    const result = parseBacklogWithBlocked(content);
    expect(result.items[0].blocked).toBe(true);
  });

  it("detects circular dependencies", () => {
    const content =
      "- [ ] TaskA | blockedBy: TaskB\n- [ ] TaskB | blockedBy: TaskA";
    const result = parseBacklogWithBlocked(content);
    const taskA = result.items.find((i) => i.text.includes("TaskA"));
    const taskB = result.items.find((i) => i.text.includes("TaskB"));
    expect(taskA?.blocked).toBe(true);
    expect(taskB?.blocked).toBe(true);
  });

  it("includes correct counts", () => {
    const content =
      "- [ ] pending\n- [>] claimed\n- [x] done";
    const result = parseBacklogWithBlocked(content);
    expect(result.pendingCount).toBe(1);
    expect(result.claimedCount).toBe(1);
    expect(result.doneCount).toBe(1);
  });

  it("handles empty string", () => {
    const result = parseBacklogWithBlocked("");
    expect(result.items).toEqual([]);
    expect(result.pendingCount).toBe(0);
  });

  it("items without blockedBy are not blocked", () => {
    const content = "- [ ] Simple task";
    const result = parseBacklogWithBlocked(content);
    expect(result.items[0].blocked).toBe(false);
  });

  it("detects transitive 3-node circular dependencies (A->B->C->A)", () => {
    const content =
      "- [ ] TaskA | blockedBy: TaskC\n- [ ] TaskB | blockedBy: TaskA\n- [ ] TaskC | blockedBy: TaskB";
    const result = parseBacklogWithBlocked(content);
    const taskA = result.items.find((i) => i.text.includes("TaskA"));
    const taskB = result.items.find((i) => i.text.includes("TaskB"));
    const taskC = result.items.find((i) => i.text.includes("TaskC"));
    expect(taskA?.blocked).toBe(true);
    expect(taskB?.blocked).toBe(true);
    expect(taskC?.blocked).toBe(true);
  });
});
