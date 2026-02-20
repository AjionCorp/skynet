// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { ActivityFeed } from "./ActivityFeed";
import { SkynetProvider } from "./SkynetProvider";
import type { EventEntry } from "../types";

const MOCK_EVENTS: EventEntry[] = [
  { ts: "2024-11-14T22:13:20.000Z", event: "task_completed", detail: "Worker 1 finished feat-login" },
  { ts: "2024-11-14T22:14:20.000Z", event: "task_failed", detail: "Worker 2 hit compile error" },
  { ts: "2024-11-14T22:15:20.000Z", event: "task_claimed", detail: "Worker 1 claimed fix-auth" },
  { ts: "2024-11-14T22:16:20.000Z", event: "worker_killed", detail: "Worker 3 killed by watchdog" },
];

function renderWithProvider(ui: React.ReactElement) {
  return render(<SkynetProvider apiPrefix="/api/admin">{ui}</SkynetProvider>);
}

function mockFetchWith(data: EventEntry[] | null, error: string | null = null) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ data, error }))
  ));
}

describe("ActivityFeed", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders event list from mock data", async () => {
    mockFetchWith(MOCK_EVENTS);
    renderWithProvider(<ActivityFeed />);
    await waitFor(() => {
      expect(screen.getByText("task_completed")).toBeDefined();
    });
    expect(screen.getByText("task_failed")).toBeDefined();
    expect(screen.getByText("task_claimed")).toBeDefined();
    expect(screen.getByText("worker_killed")).toBeDefined();
  });

  it("shows 'No events recorded' when data is empty", async () => {
    mockFetchWith([]);
    renderWithProvider(<ActivityFeed />);
    await waitFor(() => {
      expect(screen.getByText("No events recorded")).toBeDefined();
    });
  });

  it("color-codes events by type", async () => {
    mockFetchWith(MOCK_EVENTS);
    renderWithProvider(<ActivityFeed />);
    await waitFor(() => {
      expect(screen.getByText("task_completed")).toBeDefined();
    });
    const container = document.querySelector(".max-h-\\[400px\\]")!;
    const dots = container.querySelectorAll("[class*='rounded-full']");
    const dotClasses = Array.from(dots).map((d) => d.className);
    // completed -> emerald, failed -> red, claimed -> blue, killed -> amber
    expect(dotClasses.some((c) => c.includes("bg-emerald-400"))).toBe(true);
    expect(dotClasses.some((c) => c.includes("bg-red-400"))).toBe(true);
    expect(dotClasses.some((c) => c.includes("bg-blue-400"))).toBe(true);
    expect(dotClasses.some((c) => c.includes("bg-amber-400"))).toBe(true);
  });

  it("sets auto-refresh interval", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockFetchWith([]);
    renderWithProvider(<ActivityFeed />);
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
    // Advance by 10 seconds (the refresh interval)
    await vi.advanceTimersByTimeAsync(10000);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    // Advance again
    await vi.advanceTimersByTimeAsync(10000);
    expect(global.fetch).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it("displays Activity Feed header", async () => {
    mockFetchWith([]);
    renderWithProvider(<ActivityFeed />);
    expect(screen.getByText("Activity Feed")).toBeDefined();
  });

  it("displays error message when API returns error", async () => {
    mockFetchWith(null, "Server error");
    renderWithProvider(<ActivityFeed />);
    await waitFor(() => {
      expect(screen.getByText("Server error")).toBeDefined();
    });
  });

  it("displays error message when fetch throws", async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error("Network error")));
    renderWithProvider(<ActivityFeed />);
    await waitFor(() => {
      expect(screen.getByText("Network error")).toBeDefined();
    });
  });

  it("fetches from correct API endpoint", async () => {
    mockFetchWith([]);
    renderWithProvider(<ActivityFeed />);
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/admin/events");
    });
  });
});
