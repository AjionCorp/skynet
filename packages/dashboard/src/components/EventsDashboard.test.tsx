// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { EventsDashboard } from "./EventsDashboard";
import { SkynetProvider } from "./SkynetProvider";
import type { EventEntry } from "../types";

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const MOCK_EVENTS: EventEntry[] = [
  { ts: "2024-11-14T22:10:00.000Z", event: "task_claimed", detail: "Worker 1 claimed feat-login" },
  { ts: "2024-11-14T22:11:00.000Z", event: "task_completed", detail: "Worker 1 finished feat-login" },
  { ts: "2024-11-14T22:12:00.000Z", event: "task_failed", detail: "Worker 2 hit compile error" },
  { ts: "2024-11-14T22:13:00.000Z", event: "fix_started", detail: "Fixer 1 started fix for compile error" },
  { ts: "2024-11-14T22:14:00.000Z", event: "fix_succeeded", detail: "Fixer 1 resolved compile error" },
  { ts: "2024-11-14T22:15:00.000Z", event: "worker_killed", detail: "Worker 3 killed by watchdog" },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderWithProvider(ui: React.ReactElement) {
  return render(<SkynetProvider apiPrefix="/api/admin">{ui}</SkynetProvider>);
}

function mockFetchWith(data: EventEntry[] | null, error: string | null = null) {
  global.fetch = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ data, error }))
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("EventsDashboard", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders event table from mock fetch data", async () => {
    mockFetchWith(MOCK_EVENTS);
    renderWithProvider(<EventsDashboard />);
    await waitFor(() => {
      expect(screen.getByText("task_completed")).toBeDefined();
    });
    expect(screen.getByText("task_claimed")).toBeDefined();
    expect(screen.getByText("task_failed")).toBeDefined();
    expect(screen.getByText("fix_started")).toBeDefined();
    expect(screen.getByText("fix_succeeded")).toBeDefined();
    expect(screen.getByText("worker_killed")).toBeDefined();
  });

  it("filter dropdown filters by event type", async () => {
    mockFetchWith(MOCK_EVENTS);
    renderWithProvider(<EventsDashboard />);
    await waitFor(() => {
      expect(screen.getByText("task_completed")).toBeDefined();
    });

    // Select "task_failed" from filter dropdown
    const select = document.querySelector("select") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "task_failed" } });

    // Only task_failed should remain
    expect(screen.getByText("task_failed")).toBeDefined();
    expect(screen.queryByText("task_completed")).toBeNull();
    expect(screen.queryByText("task_claimed")).toBeNull();
    expect(screen.queryByText("fix_started")).toBeNull();
  });

  it("search input filters by detail text", async () => {
    mockFetchWith(MOCK_EVENTS);
    renderWithProvider(<EventsDashboard />);
    await waitFor(() => {
      expect(screen.getByText("task_completed")).toBeDefined();
    });

    // Type in search box
    const input = screen.getByPlaceholderText("Search events...");
    fireEvent.change(input, { target: { value: "compile error" } });

    // Only events with "compile error" in detail should remain
    expect(screen.getByText("task_failed")).toBeDefined();
    expect(screen.getByText("fix_started")).toBeDefined();
    expect(screen.getByText("fix_succeeded")).toBeDefined();
    expect(screen.queryByText("task_completed")).toBeNull();
    expect(screen.queryByText("task_claimed")).toBeNull();
  });

  it("empty state shows appropriate message", async () => {
    mockFetchWith([]);
    renderWithProvider(<EventsDashboard />);
    await waitFor(() => {
      expect(screen.getByText("No events found")).toBeDefined();
    });
  });

  it("fetches from correct API endpoint", async () => {
    mockFetchWith(MOCK_EVENTS);
    renderWithProvider(<EventsDashboard />);
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/admin/events");
    });
  });

  it("displays error when API returns error", async () => {
    mockFetchWith(null, "Events read failed");
    renderWithProvider(<EventsDashboard />);
    await waitFor(() => {
      expect(screen.getByText("Events read failed")).toBeDefined();
    });
  });

  it("shows empty state when filter matches nothing", async () => {
    mockFetchWith(MOCK_EVENTS);
    renderWithProvider(<EventsDashboard />);
    await waitFor(() => {
      expect(screen.getByText("task_completed")).toBeDefined();
    });

    // Search for something that doesn't exist
    const input = screen.getByPlaceholderText("Search events...");
    fireEvent.change(input, { target: { value: "nonexistent xyz" } });

    expect(screen.getByText("No events found")).toBeDefined();
  });

  it("search is case-insensitive", async () => {
    mockFetchWith(MOCK_EVENTS);
    renderWithProvider(<EventsDashboard />);
    await waitFor(() => {
      expect(screen.getByText("task_completed")).toBeDefined();
    });

    const input = screen.getByPlaceholderText("Search events...");
    fireEvent.change(input, { target: { value: "WATCHDOG" } });

    // "Worker 3 killed by watchdog" should match
    expect(screen.getByText("worker_killed")).toBeDefined();
    expect(screen.queryByText("task_completed")).toBeNull();
  });

  it("renders header with Events title", async () => {
    mockFetchWith([]);
    renderWithProvider(<EventsDashboard />);
    expect(screen.getByText("Events")).toBeDefined();
  });
});
