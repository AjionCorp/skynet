# Current Task
## [INFRA] Extract loadConfig() to shared CLI utility module — the identical `loadConfig()` function is copy-pasted in 19 CLI command files (`status.ts`, `doctor.ts`, `add-task.ts`, `pause.ts`, `resume.ts`, `run.ts`, `logs.ts`, `stop.ts`, `start.ts`, `watch.ts`, `reset-task.ts`, `validate.ts`, `setup-agents.ts`, `test-notify.ts`, `metrics.ts`, `changelog.ts`, `export.ts`, `import.ts`, `cleanup.ts`). Create `packages/cli/src/utils/loadConfig.ts` exporting a single `loadConfig(projectDir: string): Record<string, string> | null` function with the fixed regex (supporting both quoted and unquoted values). Update all 19 files to `import { loadConfig } from '../utils/loadConfig'` and delete their local copies. This makes future config parser changes (like the unquoted value fix) a single-file change instead of 19. Run `pnpm typecheck`. Criterion #3 (maintainable code — DRY principle)
**Status:** completed
**Started:** 2026-02-20 01:49
**Completed:** 2026-02-20
**Branch:** dev/extract-loadconfig-to-shared-cli-utility
**Worker:** 2

### Changes
-- See git log for details
