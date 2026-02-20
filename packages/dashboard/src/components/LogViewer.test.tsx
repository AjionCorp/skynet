// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { LogViewer } from "./LogViewer";
import { SkynetProvider } from "./SkynetProvider";
import type { LogData } from "../types";

const MOCK_LOG_DATA: LogData = {
  script: "dev-worker-1",
  lines: [
    "[2024-11-14 22:13:20] Worker 1 started",
    "[2024-11-14 22:13:21] Claiming task: feat-login",
    "[2024-11-14 22:14:30] Task completed successfully",
  ],
  totalLines: 1500,
  fileSizeBytes: 51200,
  count: 200,
};

function renderWithProvider(ui: React.ReactElement) {
  return render(<SkynetProvider apiPrefix="/api/admin">{ui}</SkynetProvider>);
}

function mockLogsGet(data: LogData | null, error: string | null = null) {
  global.fetch = vi.fn().mockImplementation(() =>
    Promise.resolve(new Response(JSON.stringify({ data, error })))
  );
}

describe("LogViewer", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders log type dropdown with all sources", async () => {
    mockLogsGet(MOCK_LOG_DATA);
    renderWithProvider(<LogViewer />);

    const select = document.querySelector("select") as HTMLSelectElement;
    expect(select).toBeDefined();

    const options = select.querySelectorAll("option");
    expect(options.length).toBe(10);

    // Verify some labels
    const labels = Array.from(options).map((o) => o.textContent);
    expect(labels).toContain("Worker 1");
    expect(labels).toContain("Worker 2");
    expect(labels).toContain("Fixer 1");
    expect(labels).toContain("Watchdog");
    expect(labels).toContain("Health Check");
    expect(labels).toContain("Project Driver");
  });

  it("displays log content in monospace pre block", async () => {
    mockLogsGet(MOCK_LOG_DATA);
    renderWithProvider(<LogViewer />);

    await waitFor(() => {
      expect(screen.getByText(/Worker 1 started/)).toBeDefined();
    });

    const pre = document.querySelector("pre");
    expect(pre).toBeDefined();
    expect(pre!.className).toContain("font-mono");
    expect(pre!.textContent).toContain("[2024-11-14 22:13:20] Worker 1 started");
    expect(pre!.textContent).toContain("Claiming task: feat-login");
    expect(pre!.textContent).toContain("Task completed successfully");
  });

  it("auto-refresh toggle works", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockLogsGet(MOCK_LOG_DATA);
    renderWithProvider(<LogViewer />);

    await waitFor(() => {
      expect(screen.getByText(/Worker 1 started/)).toBeDefined();
    });

    // Initially auto-refresh is OFF
    expect(screen.getByText("Auto-refresh OFF")).toBeDefined();

    // Click to enable
    fireEvent.click(screen.getByText("Auto-refresh OFF"));
    expect(screen.getByText("Auto-refresh ON")).toBeDefined();

    // Reset call count to track polling
    (global.fetch as ReturnType<typeof vi.fn>).mockClear();
    mockLogsGet(MOCK_LOG_DATA);

    // Advance 5 seconds — should trigger one poll
    await vi.advanceTimersByTimeAsync(5000);
    expect(global.fetch).toHaveBeenCalledTimes(1);

    // Toggle OFF
    fireEvent.click(screen.getByText("Auto-refresh ON"));
    expect(screen.getByText("Auto-refresh OFF")).toBeDefined();

    (global.fetch as ReturnType<typeof vi.fn>).mockClear();

    // Advance another 5 seconds — no more polls
    await vi.advanceTimersByTimeAsync(5000);
    expect(global.fetch).toHaveBeenCalledTimes(0);

    vi.useRealTimers();
  });

  it("shows file info when log data is loaded", async () => {
    mockLogsGet(MOCK_LOG_DATA);
    renderWithProvider(<LogViewer />);

    await waitFor(() => {
      expect(screen.getByText(/1,500 total lines/)).toBeDefined();
    });
    expect(screen.getByText(/50\.0 KB/)).toBeDefined();
  });

  it("shows 'No log data available' when lines are empty", async () => {
    mockLogsGet({ ...MOCK_LOG_DATA, lines: [] });
    renderWithProvider(<LogViewer />);

    await waitFor(() => {
      expect(screen.getByText("No log data available")).toBeDefined();
    });
  });

  it("changes source and fetches new logs", async () => {
    global.fetch = vi.fn()
      // Config fetch on mount
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { entries: [] }, error: null }))
      )
      // Initial fetch for dev-worker-1
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: MOCK_LOG_DATA, error: null }))
      )
      // Fetch after source change to watchdog
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          data: { ...MOCK_LOG_DATA, script: "watchdog", lines: ["[watchdog] checking workers..."] },
          error: null,
        }))
      );

    renderWithProvider(<LogViewer />);

    await waitFor(() => {
      expect(screen.getByText(/Worker 1 started/)).toBeDefined();
    });

    // Change source to watchdog
    const select = document.querySelector("select") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "watchdog" } });

    await waitFor(() => {
      expect(screen.getByText(/checking workers/)).toBeDefined();
    });

    // Verify second fetch was called with watchdog param
    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const watchdogCall = calls.find((c: unknown[]) =>
      typeof c[0] === "string" && (c[0] as string).includes("watchdog")
    );
    expect(watchdogCall).toBeDefined();
  });

  it("displays Log Viewer header", async () => {
    mockLogsGet(MOCK_LOG_DATA);
    renderWithProvider(<LogViewer />);
    expect(screen.getByText("Log Viewer")).toBeDefined();
  });

  it("displays error when API returns error", async () => {
    mockLogsGet(null, "Log file not found");
    renderWithProvider(<LogViewer />);
    await waitFor(() => {
      expect(screen.getByText("Log file not found")).toBeDefined();
    });
  });

  it("displays error when fetch throws", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("Network error"));
    renderWithProvider(<LogViewer />);
    await waitFor(() => {
      expect(screen.getByText("Network error")).toBeDefined();
    });
  });

  it("fetches from correct API endpoint with default params", async () => {
    mockLogsGet(MOCK_LOG_DATA);
    renderWithProvider(<LogViewer />);
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/admin/monitoring/logs?script=dev-worker-1&lines=200"
      );
    });
  });
});
