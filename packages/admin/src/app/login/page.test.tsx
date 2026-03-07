// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

const pushSpy = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushSpy }),
}));

import LoginPage from "./page";

describe("LoginPage", () => {
  beforeEach(() => {
    pushSpy.mockReset();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    pushSpy.mockReset();
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

  it("redirects to the pipeline dashboard after a successful login", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 200 }));

    render(<LoginPage />);
    fireEvent.change(screen.getByPlaceholderText("API key"), {
      target: { value: "skynet-test-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: /log in/i }));

    await waitFor(() => {
      expect(pushSpy).toHaveBeenCalledWith("/admin/pipeline");
    });
  });

  it("surfaces non-JSON auth errors instead of masking them as network failures", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response("Upstream auth proxy failed", {
        status: 502,
        headers: { "Content-Type": "text/plain" },
      })
    );

    render(<LoginPage />);
    fireEvent.change(screen.getByPlaceholderText("API key"), {
      target: { value: "skynet-test-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: /log in/i }));

    await waitFor(() => {
      expect(screen.getByText("Upstream auth proxy failed")).toBeDefined();
    });
  });

  it("falls back to the HTTP status when the error response body is empty", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(null, {
        status: 401,
        headers: { "Content-Type": "text/plain" },
      })
    );

    render(<LoginPage />);
    fireEvent.change(screen.getByPlaceholderText("API key"), {
      target: { value: "skynet-test-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: /log in/i }));

    await waitFor(() => {
      expect(screen.getByText("Authentication failed (HTTP 401)")).toBeDefined();
    });
  });
});
