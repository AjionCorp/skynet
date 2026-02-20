import { test, expect } from "@playwright/test";

// ───── (a) Events page ─────

test.describe("Events page", () => {
  test("loads and shows events table with timestamp and type columns", async ({ page }) => {
    await page.goto("/admin/events");
    // Header should show "Events" label
    await expect(page.getByText("Events").first()).toBeVisible({ timeout: 15_000 });
    // Table header columns: Timestamp, Event Type, Detail
    await expect(page.locator("th").filter({ hasText: "Timestamp" })).toBeVisible();
    await expect(page.locator("th").filter({ hasText: "Event Type" })).toBeVisible();
  });

  test("shows filter dropdown and search input", async ({ page }) => {
    await page.goto("/admin/events");
    await expect(page.getByText("Events").first()).toBeVisible({ timeout: 15_000 });
    // Filter select with "All types" default option
    await expect(page.locator("select").first()).toBeVisible();
    // Search input
    await expect(page.getByPlaceholder("Search events...")).toBeVisible();
  });

  test("no console errors on events page", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    await page.goto("/admin/events");
    await page.waitForTimeout(3000);
    expect(errors).toEqual([]);
  });
});

// ───── (b) Logs page ─────

test.describe("Logs page", () => {
  test("loads and shows log type dropdown and monospace content area", async ({ page }) => {
    await page.goto("/admin/logs");
    // "Log Viewer" heading
    await expect(page.getByText("Log Viewer")).toBeVisible({ timeout: 15_000 });
    // Source dropdown with worker options
    const sourceSelect = page.locator("select");
    await expect(sourceSelect).toBeVisible();
    // Monospace content area (pre element with font-mono class)
    await expect(page.locator("pre.font-mono").or(page.locator("pre"))).toBeVisible({ timeout: 10_000 });
  });

  test("shows auto-refresh and refresh buttons", async ({ page }) => {
    await page.goto("/admin/logs");
    await expect(page.getByText("Log Viewer")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Auto-refresh")).toBeVisible();
    await expect(page.getByRole("button", { name: "Refresh" })).toBeVisible();
  });

  test("no console errors on logs page", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    await page.goto("/admin/logs");
    await page.waitForTimeout(3000);
    expect(errors).toEqual([]);
  });
});

// ───── (c) Settings page ─────

test.describe("Settings page", () => {
  test("loads and shows config key-value table with save button", async ({ page }) => {
    await page.goto("/admin/settings");
    // Should show either "Pipeline Configuration" heading or "No configuration found" empty state
    const configHeading = page.getByText("Pipeline Configuration");
    const emptyState = page.getByText("No configuration found");
    await expect(configHeading.or(emptyState)).toBeVisible({ timeout: 15_000 });
    // Save Changes button is present when config entries exist
    const saveButton = page.getByRole("button", { name: "Save Changes" });
    const noConfig = page.getByText("No configuration found");
    // Either save button or empty state should be visible
    await expect(saveButton.or(noConfig)).toBeVisible();
  });

  test("shows refresh button", async ({ page }) => {
    await page.goto("/admin/settings");
    const configHeading = page.getByText("Pipeline Configuration");
    const emptyState = page.getByText("No configuration found");
    await expect(configHeading.or(emptyState)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: "Refresh" })).toBeVisible();
  });

  test("no console errors on settings page", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    await page.goto("/admin/settings");
    await page.waitForTimeout(3000);
    expect(errors).toEqual([]);
  });
});

// ───── (d) Workers page ─────

test.describe("Workers page", () => {
  test("loads and shows worker scaling controls with +/- buttons", async ({ page }) => {
    await page.goto("/admin/workers");
    // "Scale Workers" heading
    await expect(page.getByText("Scale Workers")).toBeVisible({ timeout: 15_000 });
    // Plus and Minus buttons (lucide-react icons)
    const minusButtons = page.locator("button").filter({ has: page.locator("svg.lucide-minus") });
    const plusButtons = page.locator("button").filter({ has: page.locator("svg.lucide-plus") });
    await expect(minusButtons.first()).toBeVisible();
    await expect(plusButtons.first()).toBeVisible();
  });

  test("shows worker type labels with counts", async ({ page }) => {
    await page.goto("/admin/workers");
    await expect(page.getByText("Scale Workers")).toBeVisible({ timeout: 15_000 });
    // Each worker row has a label and a count display (e.g. "0 / 4")
    await expect(page.locator("text=/\\d+ \\/ \\d+/").first()).toBeVisible();
  });

  test("no console errors on workers page", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    await page.goto("/admin/workers");
    await page.waitForTimeout(3000);
    expect(errors).toEqual([]);
  });
});
