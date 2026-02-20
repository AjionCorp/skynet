// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { SkynetProvider, useSkynet } from "./SkynetProvider";

/** Test consumer that renders the context value for assertions. */
function ContextConsumer() {
  const { apiPrefix } = useSkynet();
  return <div data-testid="api-prefix">{apiPrefix}</div>;
}

describe("SkynetProvider", () => {
  afterEach(() => {
    cleanup();
  });

  it("provides default apiPrefix to children via useSkynet()", () => {
    render(
      <SkynetProvider>
        <ContextConsumer />
      </SkynetProvider>
    );
    expect(screen.getByTestId("api-prefix").textContent).toBe("/api/admin");
  });

  it("provides custom apiPrefix to children via useSkynet()", () => {
    render(
      <SkynetProvider apiPrefix="/custom/prefix">
        <ContextConsumer />
      </SkynetProvider>
    );
    expect(screen.getByTestId("api-prefix").textContent).toBe("/custom/prefix");
  });

  it("provides empty string apiPrefix when explicitly set", () => {
    render(
      <SkynetProvider apiPrefix="">
        <ContextConsumer />
      </SkynetProvider>
    );
    expect(screen.getByTestId("api-prefix").textContent).toBe("");
  });

  it("renders children within the provider", () => {
    render(
      <SkynetProvider>
        <div data-testid="child-a">Child A</div>
        <div data-testid="child-b">Child B</div>
      </SkynetProvider>
    );
    expect(screen.getByTestId("child-a")).toBeDefined();
    expect(screen.getByTestId("child-b")).toBeDefined();
    expect(screen.getByText("Child A")).toBeDefined();
    expect(screen.getByText("Child B")).toBeDefined();
  });

  it("useSkynet returns default context value outside of provider", () => {
    // When used without a provider, React falls back to the createContext default
    render(<ContextConsumer />);
    expect(screen.getByTestId("api-prefix").textContent).toBe("/api/admin");
  });
});
