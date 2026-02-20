// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { WorkerScaling } from "./WorkerScaling";
import { SkynetProvider } from "./SkynetProvider";
import type { WorkerScaleInfo } from "../types";

const MOCK_WORKERS: WorkerScaleInfo[] = [
  { type: "dev-worker", label: "Dev Workers", count: 2, maxCount: 4, pids: [1001, 1002] },
  { type: "task-fixer", label: "Task Fixers", count: 1, maxCount: 3, pids: [2001] },
  { type: "watchdog", label: "Watchdog", count: 0, maxCount: 1, pids: [] },
];

function renderWithProvider(ui: React.ReactElement) {
  return render(<SkynetProvider apiPrefix="/api/admin">{ui}</SkynetProvider>);
}

function mockWorkersGet(workers: WorkerScaleInfo[]) {
  global.fetch = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ data: { workers }, error: null }))
  );
}

/** Smart mock: GET always returns workers, POST returns success */
function mockFetchSmart(workers: WorkerScaleInfo[]) {
  global.fetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      return Promise.resolve(
        new Response(JSON.stringify({ data: { message: "scaled" }, error: null }))
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify({ data: { workers }, error: null }))
    );
  });
}

describe("WorkerScaling", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders worker type rows with current counts", async () => {
    mockWorkersGet(MOCK_WORKERS);
    renderWithProvider(<WorkerScaling pollInterval={999999} />);
    await waitFor(() => {
      expect(screen.getByText("Dev Workers")).toBeDefined();
    });
    expect(screen.getByText("Task Fixers")).toBeDefined();
    expect(screen.getByText("Watchdog")).toBeDefined();
    // Check count display: "count / maxCount"
    expect(screen.getByText("2 / 4")).toBeDefined();
    expect(screen.getByText("1 / 3")).toBeDefined();
    expect(screen.getByText("0 / 1")).toBeDefined();
  });

  it("increment button triggers scale API call", async () => {
    mockFetchSmart(MOCK_WORKERS);
    renderWithProvider(<WorkerScaling pollInterval={999999} />);

    await waitFor(() => {
      expect(screen.getByText("Dev Workers")).toBeDefined();
    });

    // Each worker row has 2 buttons: [minus, plus]. 3 workers = 6 buttons.
    const buttons = screen.getAllByRole("button");
    expect(buttons.length).toBe(6);

    // Click plus for Dev Workers (index 1 = second button, the + for first row)
    fireEvent.click(buttons[1]);

    await waitFor(() => {
      const postCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.find(
        (c: unknown[]) => typeof c[1] === "object" && (c[1] as RequestInit).method === "POST"
      );
      expect(postCall).toBeDefined();
      const body = JSON.parse((postCall![1] as RequestInit).body as string);
      expect(body).toEqual({ workerType: "dev-worker", count: 3 });
    });
  });

  it("decrement button triggers scale API call", async () => {
    mockFetchSmart(MOCK_WORKERS);
    renderWithProvider(<WorkerScaling pollInterval={999999} />);

    await waitFor(() => {
      expect(screen.getByText("Dev Workers")).toBeDefined();
    });

    const buttons = screen.getAllByRole("button");

    // Click minus for Dev Workers (index 0 = first button, the - for first row)
    fireEvent.click(buttons[0]);

    await waitFor(() => {
      const postCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.find(
        (c: unknown[]) => typeof c[1] === "object" && (c[1] as RequestInit).method === "POST"
      );
      expect(postCall).toBeDefined();
      const body = JSON.parse((postCall![1] as RequestInit).body as string);
      expect(body).toEqual({ workerType: "dev-worker", count: 1 });
    });
  });

  it("disables + button at max limit", async () => {
    const atMaxWorkers: WorkerScaleInfo[] = [
      { type: "dev-worker", label: "Dev Workers", count: 4, maxCount: 4, pids: [1, 2, 3, 4] },
    ];
    mockWorkersGet(atMaxWorkers);
    renderWithProvider(<WorkerScaling pollInterval={999999} />);

    await waitFor(() => {
      expect(screen.getByText("Dev Workers")).toBeDefined();
    });

    // Single worker row: [minus, plus]
    const buttons = screen.getAllByRole("button");
    const plusButton = buttons[1] as HTMLButtonElement;
    expect(plusButton.disabled).toBe(true);
  });

  it("disables - button when count is 0", async () => {
    const zeroWorkers: WorkerScaleInfo[] = [
      { type: "watchdog", label: "Watchdog", count: 0, maxCount: 1, pids: [] },
    ];
    mockWorkersGet(zeroWorkers);
    renderWithProvider(<WorkerScaling pollInterval={999999} />);

    await waitFor(() => {
      expect(screen.getByText("Watchdog")).toBeDefined();
    });

    // Single worker row: [minus, plus]
    const buttons = screen.getAllByRole("button");
    const minusButton = buttons[0] as HTMLButtonElement;
    expect(minusButton.disabled).toBe(true);
  });

  it("displays Scale Workers header", async () => {
    mockWorkersGet([]);
    renderWithProvider(<WorkerScaling pollInterval={999999} />);
    await waitFor(() => {
      expect(screen.getByText("Scale Workers")).toBeDefined();
    });
  });

  it("displays error when API returns error", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: null, error: "Failed to read worker state" }))
    );
    renderWithProvider(<WorkerScaling pollInterval={999999} />);
    await waitFor(() => {
      expect(screen.getByText("Failed to read worker state")).toBeDefined();
    });
  });

  it("displays error when fetch throws", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("Network error"));
    renderWithProvider(<WorkerScaling pollInterval={999999} />);
    await waitFor(() => {
      expect(screen.getByText("Network error")).toBeDefined();
    });
  });

  it("fetches from correct API endpoint", async () => {
    mockWorkersGet([]);
    renderWithProvider(<WorkerScaling pollInterval={999999} />);
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/admin/workers/scale");
    });
  });
});
