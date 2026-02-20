# Current Task
## [FIX] Fix CI `lint-sh` job missing pnpm setup causing every shell lint run to fail — in `.github/workflows/ci.yml` lines 36-43, the `lint-sh` job installs shellcheck but does NOT install pnpm via `pnpm/action-setup@v4` or set up Node. The final step `pnpm lint:sh` fails with "pnpm: command not found" on every CI run. Every other job in the workflow correctly includes the pnpm/action-setup and actions/setup-node steps. Fix: add `- uses: pnpm/action-setup@v4` and `- uses: actions/setup-node@v4` with `node-version: 20` and `cache: pnpm` steps, plus `- run: pnpm install --frozen-lockfile` before the `pnpm lint:sh` step, matching the pattern in the `typecheck` job (lines 14-20). Alternatively, since `lint:sh` just runs shellcheck directly, replace `pnpm lint:sh` with the raw shellcheck command: `shellcheck -S warning scripts/*.sh scripts/agents/*.sh scripts/notify/*.sh`. Run `pnpm typecheck`. Criterion #2 (CI must actually work — broken lint job means shell script quality is ungated)
**Status:** completed
**Started:** 2026-02-20 02:47
**Completed:** 2026-02-20
**Branch:** dev/fix-ci-lint-sh-job-missing-pnpm-setup-ca
**Worker:** 1

### Changes
-- See git log for details
