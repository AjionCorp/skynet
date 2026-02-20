# Current Task
## [INFRA] Add publish workflow for `@ajioncorp/skynet` dashboard package — currently only `.github/workflows/publish-cli.yml` exists for the CLI package. The dashboard package `@ajioncorp/skynet` has `publishConfig` in `packages/dashboard/package.json` with dist paths but no GitHub Actions publish workflow. Create `.github/workflows/publish-dashboard.yml` triggered on `dashboard-v*` tags. Steps: checkout, setup Node 20, setup pnpm 10, `pnpm install`, `pnpm typecheck`, `pnpm --filter @ajioncorp/skynet test`, `pnpm --filter @ajioncorp/skynet build`, verify `packages/dashboard/dist/index.js` exists, `npm publish --provenance --access public` from `packages/dashboard/`. Follow the same pattern as `publish-cli.yml`. Run `pnpm typecheck`. Criterion #1 (dashboard package actually publishable to npm) and Criterion #2 (CI gates on every publish)
**Status:** completed
**Started:** 2026-02-20 02:32
**Completed:** 2026-02-20
**Branch:** dev/add-publish-workflow-for-ajioncorpskynet
**Worker:** 1

### Changes
-- See git log for details
