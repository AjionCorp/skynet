import { describe, it, expect } from "vitest";
import { calculateHealthScore } from "./health";

describe("calculateHealthScore", () => {
  it("returns 100 for a healthy pipeline", () => {
    expect(calculateHealthScore({ failedPendingCount: 0, blockerCount: 0, staleHeartbeatCount: 0, staleTasks24hCount: 0 })).toBe(100);
  });
  it("deducts 5 per failed task", () => {
    expect(calculateHealthScore({ failedPendingCount: 3, blockerCount: 0, staleHeartbeatCount: 0, staleTasks24hCount: 0 })).toBe(85);
  });
  it("deducts 10 per blocker", () => {
    expect(calculateHealthScore({ failedPendingCount: 0, blockerCount: 2, staleHeartbeatCount: 0, staleTasks24hCount: 0 })).toBe(80);
  });
  it("deducts 2 per stale heartbeat", () => {
    expect(calculateHealthScore({ failedPendingCount: 0, blockerCount: 0, staleHeartbeatCount: 5, staleTasks24hCount: 0 })).toBe(90);
  });
  it("deducts 1 per stale task", () => {
    expect(calculateHealthScore({ failedPendingCount: 0, blockerCount: 0, staleHeartbeatCount: 0, staleTasks24hCount: 4 })).toBe(96);
  });
  it("clamps to 0 when heavily degraded", () => {
    expect(calculateHealthScore({ failedPendingCount: 10, blockerCount: 10, staleHeartbeatCount: 10, staleTasks24hCount: 10 })).toBe(0);
  });
  it("combines all penalty types", () => {
    expect(calculateHealthScore({ failedPendingCount: 2, blockerCount: 1, staleHeartbeatCount: 3, staleTasks24hCount: 2 })).toBe(72);
  });
});
