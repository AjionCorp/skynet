# Current Task
## [TEST] Add Playwright e2e tests for admin dashboard core flows — create `packages/admin/e2e/dashboard.spec.ts` and `packages/admin/playwright.config.ts`. Configure Playwright with `webServer` pointing to `pnpm dev` on port 3100. Test cases: (1) pipeline page loads and shows health badge, (2) tasks page loads and displays pending/claimed/done counts, (3) monitoring page shows agent status, (4) sidebar navigation works between all tabs, (5) worker scaling controls render with +/- buttons, (6) mission page loads after mission viewer is built. Add `"test:e2e": "playwright test"` to `packages/admin/package.json`
**Status:** completed
**Started:** 2026-02-19 17:24
**Completed:** 2026-02-19
**Branch:** dev/add-playwright-e2e-tests-for-admin-dashb
**Worker:** 3

### Changes
-- See git log for details
