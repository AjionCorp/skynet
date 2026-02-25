import { test, expect } from "@playwright/test";

test.describe("Pipeline control on Mission page", () => {
  // Ensure pipeline is in a clean running state before each test
  test.beforeEach(async ({ request }) => {
    await request.post("/api/admin/pipeline/control", {
      data: { action: "resume" },
    });
  });

  // Restore running state after each test
  test.afterEach(async ({ request }) => {
    await request.post("/api/admin/pipeline/control", {
      data: { action: "resume" },
    });
  });

  test("working state shows Pause, Start, Stop buttons", async ({ page, request }) => {
    // Ensure running state
    await request.post("/api/admin/pipeline/control", {
      data: { action: "resume" },
    });

    await page.goto("/admin/mission");

    // Wait for page to load — either mission content or empty state
    const hasMission = page.getByRole("heading", { name: "Purpose" });
    const noMission = page.getByText("No mission defined");
    await expect(hasMission.or(noMission)).toBeVisible({ timeout: 15_000 });

    // Pipeline control buttons should be visible
    await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Start" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();

    // Resume should NOT be visible (pipeline is running, so Pause is shown instead)
    await expect(page.getByRole("button", { name: "Resume" })).not.toBeVisible();

    // Paused badge should NOT be visible
    await expect(page.getByText("Pipeline Paused")).not.toBeVisible();
  });

  test("paused state shows Resume button and paused badge", async ({ page, request }) => {
    // Set paused state via API
    await request.post("/api/admin/pipeline/control", {
      data: { action: "pause" },
    });

    await page.goto("/admin/mission");

    // Wait for page to load
    const hasMission = page.getByRole("heading", { name: "Purpose" });
    const noMission = page.getByText("No mission defined");
    await expect(hasMission.or(noMission)).toBeVisible({ timeout: 15_000 });

    // Resume should be visible (replaces Pause when paused)
    await expect(page.getByRole("button", { name: "Resume" })).toBeVisible();

    // Pipeline Paused badge should be visible
    await expect(page.getByText("Pipeline Paused")).toBeVisible();

    // Pause button should NOT be visible (Resume replaces it)
    await expect(page.getByRole("button", { name: "Pause" })).not.toBeVisible();

    // Start and Stop should still be visible
    await expect(page.getByRole("button", { name: "Start" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  });

  test("stopped state shows paused badge", async ({ page, request }) => {
    // Stop creates the pause file + kills workers
    await request.post("/api/admin/pipeline/control", {
      data: { action: "stop" },
    });

    await page.goto("/admin/mission");

    // Wait for page to load
    const hasMission = page.getByRole("heading", { name: "Purpose" });
    const noMission = page.getByText("No mission defined");
    await expect(hasMission.or(noMission)).toBeVisible({ timeout: 15_000 });

    // Stop creates the pause file, so pipeline shows as paused
    await expect(page.getByRole("button", { name: "Resume" })).toBeVisible();
    await expect(page.getByText("Pipeline Paused")).toBeVisible();
  });

  test("clicking Pause then Resume toggles UI state", async ({ page, request }) => {
    // Ensure running state
    await request.post("/api/admin/pipeline/control", {
      data: { action: "resume" },
    });

    await page.goto("/admin/mission");

    // Wait for Pause button (running state)
    await expect(page.getByRole("button", { name: "Pause" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Pipeline Paused")).not.toBeVisible();

    // Click Pause
    await page.getByRole("button", { name: "Pause" }).click();

    // After clicking, the component re-fetches — Resume should appear
    await expect(page.getByRole("button", { name: "Resume" })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Pipeline Paused")).toBeVisible();

    // Click Resume
    await page.getByRole("button", { name: "Resume" }).click();

    // After clicking, Pause should reappear
    await expect(page.getByRole("button", { name: "Pause" })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Pipeline Paused")).not.toBeVisible();
  });
});
