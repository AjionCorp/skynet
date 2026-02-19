# Current Task
## [INFRA] Add root `test` script and CI unit test job — add `"test": "pnpm -r --filter '@ajioncorp/*' test"` to root package.json so `pnpm test` runs vitest in packages/dashboard (which already has 42 unit tests across 4 test files). Add a `unit-test` job to .github/workflows/ci.yml that runs `pnpm test` after install, alongside the existing typecheck and lint-sh jobs
**Status:** completed
**Started:** 2026-02-19 16:36
**Completed:** 2026-02-19
**Branch:** dev/add-root-test-script-and-ci-unit-test-jo
**Worker:** 1

### Changes
-- See git log for details
