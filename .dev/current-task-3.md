# Current Task
## [TEST] Add vitest unit tests for core CLI commands — create `packages/cli/vitest.config.ts` with TypeScript support and `packages/cli/src/commands/__tests__/` directory. Test 4 key commands: (a) `init.test.ts` — mock `fs` and `child_process`, test `runInit()` creates `.dev/` directory with expected files, test `--name` flag sets project name, test `--non-interactive` skips prompts. (b) `doctor.test.ts` — mock `execSync` and `fs`, test healthy config outputs PASS, test missing `.dev/` outputs FAIL, test stale heartbeat outputs WARN. (c) `add-task.test.ts` — test appends task in `- [ ] [TAG] Title — desc` format, test `--position top` places before first `[x]`, test atomic write via .tmp-then-rename. (d) `config.test.ts` — test `list` parses SKYNET_* variables, test `set` validates SKYNET_MAX_WORKERS as positive integer, test rejects SKYNET_STALE_MINUTES < 5. Add `"test": "vitest run"` to `packages/cli/package.json`. CLI package currently has ZERO test coverage. Criterion #2 (catching CLI regressions)
**Status:** completed
**Started:** 2026-02-19 23:18
**Completed:** 2026-02-19
**Branch:** dev/title--desc-format-test---position-top-p
**Worker:** 3

### Changes
-- See git log for details
