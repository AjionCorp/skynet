# Current Task
## [FEAT] Add `skynet doctor` CLI diagnostics command — create packages/cli/src/commands/doctor.ts. Check: (1) required tools exist: git, node, pnpm, shellcheck — show version or MISSING, (2) skynet.config.sh exists and is parseable, (3) scripts/ directory is accessible and contains expected files (dev-worker.sh, watchdog.sh, etc.), (4) agent availability: run `claude --version` and `codex --version`, report which are available, (5) .dev/ state files exist (backlog.md, completed.md, etc.), (6) worker PID lock files — show active/stale status, (7) git repo status — clean/dirty, current branch. Output a summary with PASS/WARN/FAIL per check. Register in packages/cli/src/index.ts
**Status:** completed
**Started:** 2026-02-19 15:12
**Completed:** 2026-02-19
**Branch:** dev/add-skynet-doctor-cli-diagnostics-comman
**Worker:** 1

### Changes
-- See git log for details
