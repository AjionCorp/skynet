# Current Task
## [INFRA] Wire e2e CLI smoke test into CI workflow — in `.github/workflows/ci.yml`, add a new job `e2e-cli` alongside existing typecheck, unit-test, lint-sh jobs. Steps: checkout, setup Node 20, install pnpm, `pnpm install`, `pnpm --filter @ajioncorp/skynet-cli build` (compile CLI TypeScript), then `bash tests/e2e/init-smoke.test.sh`. This validates that `npx skynet init` scaffolding works correctly on every PR, catching regressions in the CLI path resolution and template copying logic
**Status:** completed
**Started:** 2026-02-19 17:19
**Completed:** 2026-02-19
**Branch:** dev/wire-e2e-cli-smoke-test-into-ci-workflow
**Worker:** 2

### Changes
-- See git log for details
