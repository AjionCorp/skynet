# Current Task
## [INFRA] Add CI job dependency chain to save GitHub Actions minutes — in `.github/workflows/ci.yml`, add `needs:` to expensive jobs so they skip when fast checks fail. Add: `build` → `needs: [typecheck]`, `e2e-cli` → `needs: [typecheck, unit-test]`, `e2e-admin` → `needs: [typecheck, build]`. Currently all 7 jobs run in parallel — if `typecheck` fails (the most common failure mode), 6 other jobs still run for ~15 minutes before also failing. Keep `lint-sh` and `lint-ts` independent (fast, no deps). This saves CI minutes on failures while keeping the parallel-on-success benefit for lint jobs. Criterion #2 (efficient CI pipeline)
**Status:** completed
**Started:** 2026-02-20 01:26
**Completed:** 2026-02-20
**Branch:** dev/add-ci-job-dependency-chain-to-save-gith
**Worker:** 4

### Changes
-- See git log for details
