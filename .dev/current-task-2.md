# Current Task
## [FEAT] Add `skynet changelog` CLI command for release note generation — create `packages/cli/src/commands/changelog.ts`. Reads `.dev/completed.md`, parses the pipe-delimited table, groups entries by date, organizes by tag ([FEAT] → "Features", [FIX] → "Bug Fixes", [INFRA] → "Infrastructure", [TEST] → "Tests", [DOCS] → "Documentation"). Output format: `## YYYY-MM-DD\n### Features\n- task description\n### Bug Fixes\n- task description\n...`. Default prints to stdout. Add `--output <path>` flag to write to a file. Add `--since <date>` flag to filter entries after a given date (useful for generating notes between releases). Register as `program.command('changelog').description('Generate changelog from completed tasks')` in `packages/cli/src/index.ts`. Criterion #5 (measurable mission progress → releasable artifact)
**Status:** completed
**Started:** 2026-02-20 01:13
**Completed:** 2026-02-20
**Branch:** dev/-documentation-output-format--yyyy-mm-dd
**Worker:** 2

### Changes
-- See git log for details
