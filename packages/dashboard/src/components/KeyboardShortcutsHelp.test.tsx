// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { KeyboardShortcutsHelp } from "./KeyboardShortcutsHelp";

const PAGES = [
  { href: "/admin/pipeline", label: "Pipeline" },
  { href: "/admin/tasks", label: "Tasks" },
  { href: "/admin/monitoring", label: "Monitoring" },
];

describe("KeyboardShortcutsHelp", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders title and section headers", () => {
    render(<KeyboardShortcutsHelp pages={PAGES} onClose={vi.fn()} />);
    expect(screen.getByText("Keyboard Shortcuts")).toBeDefined();
    expect(screen.getByText("Navigation")).toBeDefined();
    expect(screen.getByText("General")).toBeDefined();
  });

  it("renders page labels with numeric key bindings", () => {
    render(<KeyboardShortcutsHelp pages={PAGES} onClose={vi.fn()} />);
    expect(screen.getByText("Pipeline")).toBeDefined();
    expect(screen.getByText("Tasks")).toBeDefined();
    expect(screen.getByText("Monitoring")).toBeDefined();
    expect(screen.getByText("1")).toBeDefined();
    expect(screen.getByText("2")).toBeDefined();
    expect(screen.getByText("3")).toBeDefined();
  });

  it("uses 0 for the 10th page shortcut", () => {
    const tenPages = Array.from({ length: 10 }, (_, i) => ({
      href: `/page/${i}`,
      label: `Page ${i + 1}`,
    }));
    render(<KeyboardShortcutsHelp pages={tenPages} onClose={vi.fn()} />);
    expect(screen.getByText("0")).toBeDefined();
  });

  it("does not advertise a numeric shortcut for pages after the 10th", () => {
    const elevenPages = Array.from({ length: 11 }, (_, i) => ({
      href: `/page/${i}`,
      label: `Page ${i + 1}`,
    }));
    render(<KeyboardShortcutsHelp pages={elevenPages} onClose={vi.fn()} />);
    expect(screen.getAllByText("No shortcut").length).toBeGreaterThanOrEqual(1);
  });

  it("renders general shortcuts (? and Esc)", () => {
    render(<KeyboardShortcutsHelp pages={PAGES} onClose={vi.fn()} />);
    expect(screen.getByText("Show shortcuts")).toBeDefined();
    expect(screen.getByText("?")).toBeDefined();
    expect(screen.getByText("Close")).toBeDefined();
    expect(screen.getByText("Esc")).toBeDefined();
  });

  it("calls onClose when close button is clicked", () => {
    const onClose = vi.fn();
    render(<KeyboardShortcutsHelp pages={PAGES} onClose={onClose} />);
    // The close button contains the X icon; find button element
    const buttons = document.querySelectorAll("button");
    expect(buttons.length).toBe(1);
    fireEvent.click(buttons[0]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when clicking the overlay background", () => {
    const onClose = vi.fn();
    render(<KeyboardShortcutsHelp pages={PAGES} onClose={onClose} />);
    // The overlay is the outermost fixed div
    const overlay = document.querySelector(".fixed.inset-0")!;
    fireEvent.mouseDown(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not call onClose when clicking inside the modal content", () => {
    const onClose = vi.fn();
    render(<KeyboardShortcutsHelp pages={PAGES} onClose={onClose} />);
    fireEvent.mouseDown(screen.getByText("Keyboard Shortcuts"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("renders with empty pages list", () => {
    render(<KeyboardShortcutsHelp pages={[]} onClose={vi.fn()} />);
    expect(screen.getByText("Keyboard Shortcuts")).toBeDefined();
    expect(screen.getByText("Navigation")).toBeDefined();
  });

  it("cleans up event listener on unmount", () => {
    const removeSpy = vi.spyOn(document, "removeEventListener");
    const { unmount } = render(
      <KeyboardShortcutsHelp pages={PAGES} onClose={vi.fn()} />
    );
    unmount();
    expect(removeSpy).toHaveBeenCalledWith("mousedown", expect.any(Function));
  });
});
