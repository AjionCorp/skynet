import { test, expect } from "@playwright/test";

// ───── Page navigation ─────

test("root redirects to /admin/pipeline", async ({ page }) => {
  const res = await page.goto("/");
  expect(res?.url()).toContain("/admin/pipeline");
});

test("pipeline page loads", async ({ page }) => {
  await page.goto("/admin/pipeline");
  await expect(page.locator("body")).toBeVisible();
  // The page title in the admin header should be visible
  await expect(page.getByRole("link", { name: "Pipeline" }).first()).toBeVisible();
});

test("monitoring page loads", async ({ page }) => {
  await page.goto("/admin/monitoring");
  await expect(page.locator("body")).toBeVisible();
  // MonitoringDashboard should show the Overview tab button
  await expect(page.getByRole("button", { name: "Overview" })).toBeVisible({ timeout: 10_000 });
});

test("tasks page loads", async ({ page }) => {
  await page.goto("/admin/tasks");
  await expect(page.locator("body")).toBeVisible();
  // The Tasks nav link should be active
  await expect(page.getByRole("link", { name: "Tasks" }).first()).toBeVisible();
});

test("sync page loads", async ({ page }) => {
  await page.goto("/admin/sync");
  await expect(page.locator("body")).toBeVisible();
  await expect(page.getByRole("link", { name: "Sync" }).first()).toBeVisible();
});

// ───── Nav tabs work ─────

test("nav tabs navigate between pages", async ({ page }) => {
  await page.goto("/admin/pipeline");
  await expect(page.getByRole("link", { name: "Pipeline" }).first()).toBeVisible();

  await page.locator('a[href="/admin/monitoring"]').first().click();
  await expect(page).toHaveURL(/\/admin\/monitoring/);

  await page.locator('a[href="/admin/tasks"]').first().click();
  await expect(page).toHaveURL(/\/admin\/tasks/);

  await page.locator('a[href="/admin/sync"]').first().click();
  await expect(page).toHaveURL(/\/admin\/sync/);
});

// ───── API endpoints ─────

test("GET /api/admin/pipeline/status returns data", async ({ request }) => {
  const res = await request.get("/api/admin/pipeline/status");
  expect(res.status()).toBe(200);
  const json = await res.json();
  expect(json.data).toBeDefined();
  expect(json.data.workers).toBeInstanceOf(Array);
  expect(json.data.backlog).toBeDefined();
  expect(json.data.backlog.pendingCount).toBeGreaterThanOrEqual(0);
});

test("GET /api/admin/monitoring/status returns data", async ({ request }) => {
  const res = await request.get("/api/admin/monitoring/status");
  expect(res.status()).toBe(200);
  const json = await res.json();
  expect(json.data).toBeDefined();
  expect(json.data.workers).toBeInstanceOf(Array);
});

test("GET /api/admin/monitoring/agents returns data", async ({ request }) => {
  const res = await request.get("/api/admin/monitoring/agents");
  expect(res.status()).toBe(200);
  const json = await res.json();
  expect(json.data).toBeDefined();
});

test("GET /api/admin/monitoring/logs returns data", async ({ request }) => {
  const res = await request.get("/api/admin/monitoring/logs?script=dev-worker&lines=10");
  expect(res.status()).toBe(200);
  const json = await res.json();
  expect(json.data).toBeDefined();
  expect(json.data.lines).toBeInstanceOf(Array);
});

test("GET /api/admin/pipeline/logs returns data", async ({ request }) => {
  const res = await request.get("/api/admin/pipeline/logs?script=dev-worker&lines=10");
  expect(res.status()).toBe(200);
  const json = await res.json();
  expect(json.data).toBeDefined();
});

test("GET /api/admin/tasks returns data", async ({ request }) => {
  const res = await request.get("/api/admin/tasks");
  expect(res.status()).toBe(200);
  const json = await res.json();
  expect(json.data).toBeDefined();
});

// ───── Monitoring dashboard renders correctly ─────

test("monitoring dashboard shows summary cards after loading", async ({ page }) => {
  await page.goto("/admin/monitoring");
  // Wait for the loading spinner to disappear and summary cards to render
  await expect(page.getByText("Workers Active")).toBeVisible({ timeout: 15_000 });
  // Use exact matching for labels that appear in summary cards
  await expect(page.locator("p.text-xs.uppercase").filter({ hasText: "Backlog" })).toBeVisible();
  await expect(page.locator("p.text-xs.uppercase").filter({ hasText: "Completed" })).toBeVisible();
  await expect(page.locator("p.text-xs.uppercase").filter({ hasText: "Failed" })).toBeVisible();
});

test("monitoring dashboard shows pipeline flow", async ({ page }) => {
  await page.goto("/admin/monitoring");
  await expect(page.getByText("Pipeline Flow")).toBeVisible({ timeout: 15_000 });
});

test("monitoring dashboard tabs are clickable", async ({ page }) => {
  await page.goto("/admin/monitoring");
  await expect(page.getByRole("button", { name: "Overview" })).toBeVisible({ timeout: 15_000 });

  await page.getByRole("button", { name: "Workers" }).click();
  await expect(page.getByText("Workers Active")).toBeVisible();

  // Click the Monitoring Dashboard's own "Tasks" tab (not the nav link)
  await page.getByRole("button", { name: "Tasks" }).click();
  // Task sub-tabs should show - use specific button selector
  await expect(page.getByRole("button", { name: /backlog/i })).toBeVisible();

  await page.getByRole("button", { name: "System" }).click();
  await expect(page.getByText("Authentication")).toBeVisible({ timeout: 10_000 });
});

// ───── No client-side errors ─────

test("no console errors on pipeline page", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await page.goto("/admin/pipeline");
  await page.waitForTimeout(3000);
  expect(errors).toEqual([]);
});

test("no console errors on monitoring page", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await page.goto("/admin/monitoring");
  await page.waitForTimeout(5000);
  expect(errors).toEqual([]);
});

test("no console errors on tasks page", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await page.goto("/admin/tasks");
  await page.waitForTimeout(3000);
  expect(errors).toEqual([]);
});

test("no console errors on sync page", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await page.goto("/admin/sync");
  await page.waitForTimeout(3000);
  expect(errors).toEqual([]);
});
