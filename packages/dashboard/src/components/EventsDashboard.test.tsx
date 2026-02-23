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
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ data, error }))
  ));
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
      // Event types appear in both filter dropdown <option> and table <span>, so use getAllByText
      expect(screen.getAllByText("task_completed").length).toBeGreaterThanOrEqual(1);
    });
    expect(screen.getAllByText("task_claimed").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("task_failed").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("fix_started").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("fix_succeeded").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("worker_killed").length).toBeGreaterThanOrEqual(1);
  });

  it("filter dropdown filters by event type", async () => {
    mockFetchWith(MOCK_EVENTS);
    renderWithProvider(<EventsDashboard />);
    await waitFor(() => {
      expect(screen.getAllByText("task_completed").length).toBeGreaterThanOrEqual(1);
    });

    // Select "task_failed" from filter dropdown
    const select = document.querySelector("select") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "task_failed" } });

    // Only task_failed should remain in the table; other event types still in dropdown options
    // The table should only show task_failed rows
    const rows = document.querySelectorAll("tbody tr");
    expect(rows.length).toBe(1);
    expect(screen.getAllByText("task_failed").length).toBeGreaterThanOrEqual(1);
  });

  it("search input filters by detail text", async () => {
    mockFetchWith(MOCK_EVENTS);
    renderWithProvider(<EventsDashboard />);
    await waitFor(() => {
      expect(screen.getAllByText("task_completed").length).toBeGreaterThanOrEqual(1);
    });

    // Type in search box
    const input = screen.getByPlaceholderText("Search events...");
    fireEvent.change(input, { target: { value: "compile error" } });

    // Only events with "compile error" in detail should remain in the table
    const rows = document.querySelectorAll("tbody tr");
    expect(rows.length).toBe(3); // task_failed, fix_started, fix_succeeded
    expect(screen.getAllByText("task_failed").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("fix_started").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("fix_succeeded").length).toBeGreaterThanOrEqual(1);
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
      expect(screen.getAllByText("task_completed").length).toBeGreaterThanOrEqual(1);
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
      expect(screen.getAllByText("task_completed").length).toBeGreaterThanOrEqual(1);
    });

    const input = screen.getByPlaceholderText("Search events...");
    fireEvent.change(input, { target: { value: "WATCHDOG" } });

    // "Worker 3 killed by watchdog" should match — only 1 row in table
    const rows = document.querySelectorAll("tbody tr");
    expect(rows.length).toBe(1);
    expect(screen.getAllByText("worker_killed").length).toBeGreaterThanOrEqual(1);
  });

  it("renders header with Events title", async () => {
    mockFetchWith([]);
    renderWithProvider(<EventsDashboard />);
    expect(screen.getByText("Events")).toBeDefined();
  });
});
