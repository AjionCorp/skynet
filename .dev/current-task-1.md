# Current Task
## [INFRA] Add `timeout-minutes` to all CI workflow jobs to prevent runaway builds — in `.github/workflows/ci.yml`, the `e2e-admin` Playwright job has no `timeout-minutes`, defaulting to GitHub's 6-hour maximum. If Playwright hangs, the job wastes CI minutes. Fix: add `timeout-minutes: 10` to `e2e-admin` and `e2e-cli` jobs, `timeout-minutes: 5` to `typecheck`, `build`, `lint-sh`, and `lint-ts` jobs, `timeout-minutes: 10` to `unit-test`. These generous limits prevent hangs without interrupting legitimate runs. Criterion #2 (efficient CI — no wasted GitHub Actions minutes)
**Status:** completed
**Started:** 2026-02-20 02:05
**Completed:** 2026-02-20
**Branch:** dev/add-timeout-minutes-to-all-ci-workflow-j
**Worker:** 1

### Changes
-- See git log for details
