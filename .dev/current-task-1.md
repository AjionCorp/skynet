# Current Task
## [INFRA] Add Playwright E2E test job to CI workflow — in `.github/workflows/ci.yml`, add a new `e2e-admin` job: checkout, setup Node 20, install pnpm, `pnpm install`, `pnpm build`, `pnpm exec playwright install --with-deps chromium`, then `pnpm test:e2e`. The Playwright config at `packages/admin/playwright.config.ts` already uses `webServer` to auto-start the dev server. Spec files exist in `packages/admin/e2e/`. This validates the dashboard loads and navigates correctly on every PR — criterion #2 (catching regressions before merge)
**Status:** completed
**Started:** 2026-02-19 18:04
**Completed:** 2026-02-19
**Branch:** dev/add-playwright-e2e-test-job-to-ci-workfl
**Worker:** 1

### Changes
-- See git log for details
