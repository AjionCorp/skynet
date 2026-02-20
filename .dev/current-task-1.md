# Current Task
## [TEST] Add `export.test.ts`, `dashboard.test.ts`, and `import.test.ts` CLI unit tests — the last 3 of 21 CLI commands without test coverage. Create in `packages/cli/src/commands/__tests__/`. For `export.test.ts`: mock `fs.readFileSync` for `.dev/` files, test JSON output contains all expected keys (backlog.md, completed.md, failed-tasks.md, blockers.md, mission.md, skynet.config.sh, events.log), test `--output` flag writes to custom path, test handles missing `.dev/` files gracefully (empty string value). For `dashboard.test.ts`: mock `child_process.spawn`, test launches pnpm dev command with correct `--port` argument, test default port is 3100, test `--port` flag overrides, test opens browser via `open` on macOS / `xdg-open` on Linux (mock `process.platform`). For `import.test.ts`: mock `fs.readFileSync` and `fs.writeFileSync`, test validates snapshot JSON has expected keys, test rejects invalid JSON, test `--dry-run` shows diff without writing, test `--merge` appends to .md files instead of overwriting, test `--force` skips confirmation prompt. Follow patterns in `init.test.ts` and `config.test.ts`. Criterion #2 (100% CLI test coverage)
**Status:** completed
**Started:** 2026-02-20 00:47
**Completed:** 2026-02-20
**Branch:** dev/add-exporttestts-dashboardtestts-and-imp
**Worker:** 1

### Changes
-- See git log for details
