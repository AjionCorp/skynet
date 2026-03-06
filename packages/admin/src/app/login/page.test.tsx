// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

const pushMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

import LoginPage from "./page";

describe("LoginPage", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    pushMock.mockReset();
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

  it("redirects successful logins to the pipeline dashboard", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 200 })));

    render(<LoginPage />);
    fireEvent.change(screen.getByPlaceholderText("API key"), {
      target: { value: "test-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: /log in/i }));

    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith("/admin/pipeline");
    });
  });
});
