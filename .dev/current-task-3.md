# Current Task
## [TEST] Add CLI unit tests for watch, run, upgrade, and cleanup commands — FRESH implementation (delete stale branch `dev/add-cli-unit-tests-for-watch-run-upgrade` first). Create 4 test files in `packages/cli/src/commands/__tests__/`: (a) `watch.test.ts` — mock fs.readFileSync and setInterval, verify it reads state files and formats output. (b) `run.test.ts` — mock child_process.spawn, verify it constructs the correct dev-worker.sh command with SKYNET_ONE_SHOT=true. (c) `upgrade.test.ts` — mock execSync for `npm view`, test version comparison logic. (d) `cleanup.test.ts` — mock execSync for git commands, test --dry-run vs --force behavior. Follow existing patterns in `packages/cli/src/commands/__tests__/init.test.ts`. Currently 4 of 20 CLI commands have unit tests. Criterion #2
**Status:** completed
**Started:** 2026-02-20 00:24
**Completed:** 2026-02-20
**Branch:** dev/add-cli-unit-tests-for-watch-run-upgrade
**Worker:** 3

### Changes
-- See git log for details
