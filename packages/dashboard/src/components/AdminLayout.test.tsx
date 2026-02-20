// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { AdminLayout } from "./AdminLayout";
import type { AdminLayoutPage } from "./AdminLayout";

const PAGES: AdminLayoutPage[] = [
  { href: "/admin/pipeline", label: "Pipeline" },
  { href: "/admin/tasks", label: "Tasks" },
  { href: "/admin/monitoring", label: "Monitoring" },
  { href: "/admin/workers", label: "Workers" },
  { href: "/admin/logs", label: "Logs" },
  { href: "/admin/mission", label: "Mission" },
  { href: "/admin/events", label: "Events" },
  { href: "/admin/settings", label: "Settings" },
  { href: "/admin/prompts", label: "Prompts" },
  { href: "/admin/sync", label: "Sync" },
];

describe("AdminLayout", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders sidebar navigation with all expected links", () => {
    render(
      <AdminLayout pages={PAGES}>
        <div>content</div>
      </AdminLayout>
    );
    for (const page of PAGES) {
      // Each page label appears twice: once in header nav, once in sub-nav tabs
      const matches = screen.getAllByText(page.label);
      expect(matches.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("highlights active link via pathname matching", () => {
    render(
      <AdminLayout pages={PAGES} currentPath="/admin/tasks">
        <div>content</div>
      </AdminLayout>
    );
    // The sub-nav tab for "Tasks" should have the active border class
    const taskLinks = screen.getAllByText("Tasks");
    const activeLink = taskLinks.find((el) => el.closest("a")?.className.includes("border-cyan-400"));
    expect(activeLink).toBeDefined();
  });

  it("does not highlight inactive links", () => {
    render(
      <AdminLayout pages={PAGES} currentPath="/admin/tasks">
        <div>content</div>
      </AdminLayout>
    );
    // "Pipeline" sub-nav tab should have transparent border (inactive)
    const pipelineLinks = screen.getAllByText("Pipeline");
    const inactiveLink = pipelineLinks.find((el) => el.closest("a")?.className.includes("border-transparent"));
    expect(inactiveLink).toBeDefined();
  });

  it("renders children content area correctly", () => {
    render(
      <AdminLayout pages={PAGES}>
        <div data-testid="child-content">Hello from children</div>
      </AdminLayout>
    );
    expect(screen.getByTestId("child-content")).toBeDefined();
    expect(screen.getByText("Hello from children")).toBeDefined();
  });

  it("shows user badge when user prop is provided", () => {
    render(
      <AdminLayout pages={PAGES} user={{ email: "admin@example.com" }}>
        <div>content</div>
      </AdminLayout>
    );
    expect(screen.getByText("admin@example.com")).toBeDefined();
    expect(screen.getByText("A")).toBeDefined(); // first letter avatar
  });

  it("does not show user badge when user prop is omitted", () => {
    render(
      <AdminLayout pages={PAGES}>
        <div>content</div>
      </AdminLayout>
    );
    expect(screen.queryByText("admin@example.com")).toBeNull();
  });

  it("renders back link with default label", () => {
    render(
      <AdminLayout pages={PAGES}>
        <div>content</div>
      </AdminLayout>
    );
    expect(screen.getByText("Dashboard")).toBeDefined();
  });

  it("renders back link with custom label and href", () => {
    render(
      <AdminLayout pages={PAGES} backHref="/home" backLabel="Home">
        <div>content</div>
      </AdminLayout>
    );
    expect(screen.getByText("Home")).toBeDefined();
    const homeLink = screen.getByText("Home").closest("a");
    expect(homeLink?.getAttribute("href")).toBe("/home");
  });

  it("renders without pages (empty nav)", () => {
    render(
      <AdminLayout>
        <div>minimal layout</div>
      </AdminLayout>
    );
    expect(screen.getByText("minimal layout")).toBeDefined();
    expect(screen.getByText("Admin")).toBeDefined();
  });
});
