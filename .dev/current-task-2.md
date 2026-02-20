# Current Task
## [INFRA] Add standalone `build` verification job to CI workflow — in `.github/workflows/ci.yml`, add a `build` job that runs `pnpm build` to compile all TypeScript packages (admin, dashboard, CLI). Currently `pnpm build` is only run implicitly as part of the `e2e-admin` job, meaning build failures can be masked by earlier job failures. The new job should run after `install` (same pnpm store cache pattern as other jobs). Steps: checkout, setup Node 20, setup pnpm, `pnpm install`, `pnpm build`. This catches TypeScript compilation errors that `pnpm typecheck` might miss (since typecheck doesn't emit files). Criterion #2 (catching build errors before merge)
**Status:** completed
**Started:** 2026-02-20 00:32
**Completed:** 2026-02-20
**Branch:** dev/add-standalone-build-verification-job-to
**Worker:** 2

### Changes
-- See git log for details
