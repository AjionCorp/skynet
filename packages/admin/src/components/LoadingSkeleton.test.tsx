// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { LoadingSkeleton } from "./LoadingSkeleton";

describe("LoadingSkeleton", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders loading text", () => {
    render(<LoadingSkeleton />);
    expect(screen.getByText("Loading...")).toBeDefined();
  });

  it("renders a spinner with animate-spin class", () => {
    const { container } = render(<LoadingSkeleton />);
    const spinner = container.querySelector(".animate-spin");
    expect(spinner).not.toBeNull();
  });

  it("has centered layout styling", () => {
    const { container } = render(<LoadingSkeleton />);
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.className).toContain("flex");
    expect(wrapper.className).toContain("items-center");
    expect(wrapper.className).toContain("justify-center");
  });
});
