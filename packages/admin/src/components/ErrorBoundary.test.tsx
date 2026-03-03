// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ErrorBoundary } from "./ErrorBoundary";

function ThrowingChild({ error }: { error: Error }) {
  throw error;
}

function GoodChild() {
  return <p>All good</p>;
}

describe("ErrorBoundary", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders children when no error occurs", () => {
    render(
      <ErrorBoundary>
        <GoodChild />
      </ErrorBoundary>,
    );
    expect(screen.getByText("All good")).toBeDefined();
  });

  it("displays error UI when a child throws", () => {
    render(
      <ErrorBoundary>
        <ThrowingChild error={new Error("Test explosion")} />
      </ErrorBoundary>,
    );
    expect(screen.getByText("Something went wrong")).toBeDefined();
    expect(screen.getByText("Test explosion")).toBeDefined();
  });

  it("shows the error message in the detail paragraph", () => {
    render(
      <ErrorBoundary>
        <ThrowingChild error={new Error("specific failure")} />
      </ErrorBoundary>,
    );
    const detail = screen.getByText("specific failure");
    expect(detail.className).toContain("text-zinc-500");
  });

  it("renders a Retry button that reloads the page", () => {
    const reloadMock = vi.fn();
    Object.defineProperty(window, "location", {
      value: { reload: reloadMock },
      writable: true,
    });

    render(
      <ErrorBoundary>
        <ThrowingChild error={new Error("boom")} />
      </ErrorBoundary>,
    );

    const button = screen.getByRole("button", { name: /retry/i });
    expect(button).toBeDefined();
    fireEvent.click(button);
    expect(reloadMock).toHaveBeenCalledTimes(1);
  });

  it("logs error via componentDidCatch", () => {
    render(
      <ErrorBoundary>
        <ThrowingChild error={new Error("caught error")} />
      </ErrorBoundary>,
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "[ErrorBoundary]",
      expect.any(Error),
      expect.objectContaining({ componentStack: expect.any(String) }),
    );
  });

  it("getDerivedStateFromError returns correct state", () => {
    const error = new Error("test");
    const state = ErrorBoundary.getDerivedStateFromError(error);
    expect(state).toEqual({ hasError: true, error });
  });
});
