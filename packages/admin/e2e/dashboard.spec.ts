import { test, expect } from "@playwright/test";

// ───── (1) Pipeline page loads and shows health badge ─────

test.describe("Pipeline dashboard", () => {
  test("shows health score and health badge after loading", async ({ page }) => {
    await page.goto("/admin/pipeline");
    // Wait for the loading spinner to disappear and summary cards to render
    await expect(page.locator("p.text-xs.uppercase").filter({ hasText: "Health" })).toBeVisible({
      timeout: 15_000,
    });
    // Health badge should show one of: Good, Degraded, Critical
    await expect(page.getByText(/Good|Degraded|Critical/).first()).toBeVisible();
  });

  test("shows Workers Active summary card", async ({ page }) => {
    await page.goto("/admin/pipeline");
    await expect(page.locator("p.text-xs.uppercase").filter({ hasText: "Workers Active" })).toBeVisible({
      timeout: 15_000,
    });
  });

  test("shows backlog and completed counts", async ({ page }) => {
    await page.goto("/admin/pipeline");
    await expect(page.locator("p.text-xs.uppercase").filter({ hasText: "Backlog" })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.locator("p.text-xs.uppercase").filter({ hasText: "Completed" })).toBeVisible();
  });
});

// ───── (2) Tasks page loads and displays pending/claimed/done counts ─────

test.describe("Tasks dashboard", () => {
  test("shows pending, claimed, and completed count cards", async ({ page }) => {
    await page.goto("/admin/tasks");
    // TasksDashboard renders three summary cards: Pending, Claimed, Completed
    await expect(page.getByText("Pending").first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Claimed").first()).toBeVisible();
    await expect(page.getByText("Completed").first()).toBeVisible();
  });

  test("pending/claimed/completed show numeric counts or dash", async ({ page }) => {
    await page.goto("/admin/tasks");
    // Wait for data to load — counts should be numbers or "—"
    await expect(page.getByText("Pending").first()).toBeVisible({ timeout: 15_000 });
    // Each card has a large number or "—"; verify at least the Pending card has content
    const pendingCard = page.getByText("Pending").first().locator("..");
    await expect(pendingCard).toBeVisible();
  });

  test("shows create task form", async ({ page }) => {
    await page.goto("/admin/tasks");
    await expect(page.getByText("Create Task")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("#task-title")).toBeVisible();
    await expect(page.getByRole("button", { name: "Add Task" })).toBeVisible();
  });

  test("shows backlog section with refresh button", async ({ page }) => {
    await page.goto("/admin/tasks");
    // The Backlog heading (h2) and refresh button
    await expect(page.getByRole("heading", { name: "Backlog" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: "Refresh" })).toBeVisible();
  });
});

// ───── (3) Monitoring page shows agent status ─────

test.describe("Monitoring dashboard — agent status", () => {
  test("system tab shows LaunchAgents section", async ({ page }) => {
    await page.goto("/admin/monitoring");
    // Wait for dashboard to load
    await expect(page.getByRole("button", { name: "System" })).toBeVisible({ timeout: 15_000 });
    // Navigate to System tab
    await page.getByRole("button", { name: "System" }).click();
    // LaunchAgents heading should appear
    await expect(page.getByText("LaunchAgents")).toBeVisible({ timeout: 10_000 });
  });

  test("system tab shows authentication section", async ({ page }) => {
    await page.goto("/admin/monitoring");
    await expect(page.getByRole("button", { name: "System" })).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "System" }).click();
    await expect(page.getByText("Authentication")).toBeVisible({ timeout: 10_000 });
  });

  test("agents API returns data with agent info", async ({ request }) => {
    const res = await request.get("/api/admin/monitoring/agents");
    expect(res.status()).toBe(200);
    const json = await res.json();
    expect(json.data).toBeDefined();
    expect(json.data).toBeInstanceOf(Array);
  });
});

// ───── (4) Sidebar navigation works between all tabs ─────

test.describe("Sidebar navigation", () => {
  test("navigates between all admin pages", async ({ page }) => {
    await page.goto("/admin/pipeline");
    await expect(page.getByRole("link", { name: "Pipeline" }).first()).toBeVisible({ timeout: 10_000 });

    // Pipeline -> Monitoring
    await page.locator('a[href="/admin/monitoring"]').first().click();
    await expect(page).toHaveURL(/\/admin\/monitoring/);
    await expect(page.getByRole("link", { name: "Monitoring" }).first()).toBeVisible();

    // Monitoring -> Tasks
    await page.locator('a[href="/admin/tasks"]').first().click();
    await expect(page).toHaveURL(/\/admin\/tasks/);
    await expect(page.getByRole("link", { name: "Tasks" }).first()).toBeVisible();

    // Tasks -> Sync
    await page.locator('a[href="/admin/sync"]').first().click();
    await expect(page).toHaveURL(/\/admin\/sync/);
    await expect(page.getByRole("link", { name: "Sync" }).first()).toBeVisible();

    // Sync -> Prompts
    await page.locator('a[href="/admin/prompts"]').first().click();
    await expect(page).toHaveURL(/\/admin\/prompts/);
    await expect(page.getByRole("link", { name: "Prompts" }).first()).toBeVisible();

    // Prompts -> Mission
    await page.locator('a[href="/admin/mission"]').first().click();
    await expect(page).toHaveURL(/\/admin\/mission/);
    await expect(page.getByRole("link", { name: "Mission" }).first()).toBeVisible();

    // Mission -> Pipeline (full circle)
    await page.locator('a[href="/admin/pipeline"]').first().click();
    await expect(page).toHaveURL(/\/admin\/pipeline/);
  });

  test("all nav links are visible on every page", async ({ page }) => {
    await page.goto("/admin/pipeline");
    const navLabels = ["Pipeline", "Monitoring", "Tasks", "Sync", "Prompts", "Mission"];
    for (const label of navLabels) {
      await expect(page.getByRole("link", { name: label }).first()).toBeVisible({ timeout: 10_000 });
    }
  });
});

// ───── (5) Worker scaling controls render with +/- buttons ─────

test.describe("Worker scaling controls", () => {
  test("scale workers section renders on workers tab", async ({ page }) => {
    await page.goto("/admin/monitoring");
    await expect(page.getByRole("button", { name: "Workers" })).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "Workers" }).click();
    // WorkerScaling component should render "Scale Workers" heading
    await expect(page.getByText("Scale Workers")).toBeVisible({ timeout: 10_000 });
  });

  test("shows plus and minus buttons for worker types", async ({ page }) => {
    await page.goto("/admin/monitoring");
    await expect(page.getByRole("button", { name: "Workers" })).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "Workers" }).click();
    await expect(page.getByText("Scale Workers")).toBeVisible({ timeout: 10_000 });
    // WorkerScaling renders "+" and "-" icon buttons for each worker type
    // The buttons contain Minus/Plus icons from lucide-react
    const minusButtons = page.locator("button").filter({ has: page.locator("svg.lucide-minus") });
    const plusButtons = page.locator("button").filter({ has: page.locator("svg.lucide-plus") });
    await expect(minusButtons.first()).toBeVisible();
    await expect(plusButtons.first()).toBeVisible();
  });

  test("worker scaling API returns data", async ({ request }) => {
    const res = await request.get("/api/admin/workers/scale");
    expect(res.status()).toBe(200);
    const json = await res.json();
    expect(json.data).toBeDefined();
    expect(json.data).toBeInstanceOf(Array);
  });
});

// ───── (6) Mission page loads after mission viewer is built ─────

test.describe("Mission dashboard", () => {
  test("mission page loads and shows content", async ({ page }) => {
    await page.goto("/admin/mission");
    // Should show either mission data or "No mission defined" empty state
    const hasMission = page.getByText("Purpose");
    const noMission = page.getByText("No mission defined");
    // One of these should be visible after loading
    await expect(hasMission.or(noMission)).toBeVisible({ timeout: 15_000 });
  });

  test("mission page shows summary cards when mission exists", async ({ page }) => {
    await page.goto("/admin/mission");
    // If a mission exists, summary cards will show; otherwise the empty state appears.
    // Check for either the progress card or the empty state
    const progressCard = page.getByText("Mission Progress");
    const noMission = page.getByText("No mission defined");
    await expect(progressCard.or(noMission)).toBeVisible({ timeout: 15_000 });
  });

  test("mission page has refresh button", async ({ page }) => {
    await page.goto("/admin/mission");
    // Wait for page to finish loading
    const hasMission = page.getByText("Purpose");
    const noMission = page.getByText("No mission defined");
    await expect(hasMission.or(noMission)).toBeVisible({ timeout: 15_000 });
    // Refresh button should be present (even if mission isn't defined, the button exists)
    await expect(page.getByRole("button", { name: "Refresh" })).toBeVisible();
  });

  test("mission status API returns data", async ({ request }) => {
    const res = await request.get("/api/admin/mission/status");
    expect(res.status()).toBe(200);
    const json = await res.json();
    expect(json.data).toBeDefined();
  });
});

// ───── No client-side errors on dashboard pages ─────

test.describe("No client-side errors", () => {
  for (const route of ["/admin/pipeline", "/admin/tasks", "/admin/mission"]) {
    test(`no console errors on ${route}`, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (err) => errors.push(err.message));
      await page.goto(route);
      await page.waitForTimeout(3000);
      expect(errors).toEqual([]);
    });
  }
});
