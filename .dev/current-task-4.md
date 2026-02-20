# Current Task
## [INFRA] Add `pnpm install --frozen-lockfile` to worker flow before typecheck — in `scripts/dev-worker.sh`, the quality gate section runs `pnpm typecheck` but does NOT run `pnpm install` first. When the pnpm lockfile has been updated (e.g., new dependency added) but the worktree's `node_modules` is stale, typecheck fails with "Cannot find module" errors. This caused 5 recent task failures (all "typecheck failed" with TS2307 for vitest). Fix: in `dev-worker.sh`, before the first quality gate evaluation, add `pnpm install --frozen-lockfile >> "$LOG" 2>&1` to ensure dependencies are fresh. Only run if `pnpm-lock.yaml` has changed since last install (check mtime of `node_modules/.modules.yaml` vs `pnpm-lock.yaml`). Run `pnpm typecheck`. Criterion #3 (reliable quality gates — dependencies must be installed before typecheck)
**Status:** completed
**Started:** 2026-02-20 03:04
**Completed:** 2026-02-20
**Branch:** dev/add-pnpm-install---frozen-lockfile-to-wo
**Worker:** 4

### Changes
-- See git log for details
