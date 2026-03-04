// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

import LoginPage from "./page";

describe("LoginPage", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders without crashing", () => {
    const { container } = render(<LoginPage />);
    expect(container.firstElementChild).not.toBeNull();
  });

  it("renders the title and description", () => {
    render(<LoginPage />);
    expect(screen.getByText("Skynet Admin")).toBeDefined();
    expect(
      screen.getByText("Enter your API key to continue."),
    ).toBeDefined();
  });

  it("renders the API key input", () => {
    render(<LoginPage />);
    const input = screen.getByPlaceholderText("API key");
    expect(input).toBeDefined();
    expect(input.getAttribute("type")).toBe("password");
  });

  it("renders the login button", () => {
    render(<LoginPage />);
    const button = screen.getByRole("button", { name: /log in/i });
    expect(button).toBeDefined();
  });

  it("disables the button when input is empty", () => {
    render(<LoginPage />);
    const button = screen.getByRole("button", { name: /log in/i });
    expect(button.hasAttribute("disabled")).toBe(true);
  });
});
