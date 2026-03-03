import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { checkRateLimit, _resetRateLimits } from "./rate-limiter";

beforeEach(() => {
  _resetRateLimits();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("checkRateLimit", () => {
  it("allows requests under the limit", () => {
    expect(checkRateLimit("test", 3, 60_000)).toBe(true);
    expect(checkRateLimit("test", 3, 60_000)).toBe(true);
    expect(checkRateLimit("test", 3, 60_000)).toBe(true);
  });

  it("blocks requests exceeding the limit", () => {
    for (let i = 0; i < 3; i++) checkRateLimit("test", 3, 60_000);
    expect(checkRateLimit("test", 3, 60_000)).toBe(false);
  });

  it("allows requests again after the window expires", () => {
    for (let i = 0; i < 3; i++) checkRateLimit("test", 3, 60_000);
    expect(checkRateLimit("test", 3, 60_000)).toBe(false);

    vi.advanceTimersByTime(60_001);
    expect(checkRateLimit("test", 3, 60_000)).toBe(true);
  });

  it("uses separate windows per key", () => {
    for (let i = 0; i < 3; i++) checkRateLimit("key-a", 3, 60_000);
    expect(checkRateLimit("key-a", 3, 60_000)).toBe(false);
    expect(checkRateLimit("key-b", 3, 60_000)).toBe(true);
  });

  it("implements sliding window - oldest entries expire first", () => {
    // t=0: first request
    checkRateLimit("test", 2, 1000);
    // t=500: second request
    vi.advanceTimersByTime(500);
    checkRateLimit("test", 2, 1000);
    // t=500: at limit
    expect(checkRateLimit("test", 2, 1000)).toBe(false);

    // t=1001: first request expired, second still active
    vi.advanceTimersByTime(501);
    expect(checkRateLimit("test", 2, 1000)).toBe(true);
    // Now at limit again (second original + new one)
    expect(checkRateLimit("test", 2, 1000)).toBe(false);
  });

  it("handles maxCount of 1", () => {
    expect(checkRateLimit("once", 1, 60_000)).toBe(true);
    expect(checkRateLimit("once", 1, 60_000)).toBe(false);
  });

  it("handles very short windows", () => {
    expect(checkRateLimit("short", 1, 1)).toBe(true);
    expect(checkRateLimit("short", 1, 1)).toBe(false);
    vi.advanceTimersByTime(2);
    expect(checkRateLimit("short", 1, 1)).toBe(true);
  });
});

describe("_resetRateLimits", () => {
  it("clears all rate limit state", () => {
    for (let i = 0; i < 5; i++) checkRateLimit("test", 5, 60_000);
    expect(checkRateLimit("test", 5, 60_000)).toBe(false);

    _resetRateLimits();
    expect(checkRateLimit("test", 5, 60_000)).toBe(true);
  });
});
