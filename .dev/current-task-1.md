# Current Task
## [FEAT] Add `skynet validate` CLI command for pre-flight project validation — create `packages/cli/src/commands/validate.ts`. Unlike `doctor` (which checks the pipeline itself), `validate` checks the TARGET project's readiness: (a) parse `SKYNET_GATE_N` variables from config and dry-run each gate command, reporting pass/fail per gate, (b) verify git remote is accessible via `git ls-remote origin HEAD`, (c) check disk space in project dir (warn if < 1GB free), (d) verify `.dev/mission.md` exists and has content. Print summary: "N/M pre-flight checks passed". Register as `program.command('validate').description('Run pre-flight checks for the target project')` in `packages/cli/src/index.ts`. This helps users verify their project is correctly set up BEFORE starting the pipeline. Criterion #1 (under 5 min to autonomous — validate catches config issues early)
**Status:** completed
**Started:** 2026-02-20 01:28
**Completed:** 2026-02-20
**Branch:** dev/add-skynet-validate-cli-command-for-pre-
**Worker:** 1

### Changes
-- See git log for details
