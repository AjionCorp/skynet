# Current Task
## [TEST] Add `logs.test.ts`, `start.test.ts`, `stop.test.ts`, and `version.test.ts` CLI unit tests — create 4 test files in `packages/cli/src/commands/__tests__/`. For `logs.test.ts`: mock `fs.readdirSync` and `fs.readFileSync` for log file listing, test `--tail N` reads last N lines, test `--follow` sets up `fs.watch`, test missing log directory returns helpful message, test `--id` flag selects correct worker log. For `start.test.ts`: mock `child_process.spawn`, test launches watchdog.sh, test detects already-running via PID lock file. For `stop.test.ts`: mock `fs.readFileSync` for PID files, test sends SIGTERM to workers, test handles missing PID files gracefully. For `version.test.ts`: mock package.json read, test outputs version string, mock `execSync` for npm update check, test outdated version suggests upgrade command. Follow existing CLI test patterns in `init.test.ts`. Criterion #2
**Status:** completed
**Started:** 2026-02-20 00:33
**Completed:** 2026-02-20
**Branch:** dev/add-logstestts-starttestts-stoptestts-an
**Worker:** 3

### Changes
-- See git log for details
