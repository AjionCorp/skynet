# Current Task
## [FIX] Add `validate`, `changelog`, and `--from-snapshot` to completions.ts — in `packages/cli/src/commands/completions.ts`, the `COMMANDS` object (lines 1-25) is missing 2 registered commands and 1 flag: (1) Add `validate: ["--dir", "--help"]` to COMMANDS. (2) Add `changelog: ["--since", "--output", "--dir", "--help"]` to COMMANDS. (3) Add `"--from-snapshot"` to the `init` flags array (currently only has `--name`, `--dir`, `--copy-scripts`, `--non-interactive`). (4) In the zsh `commands` array (lines 90-114), add `'validate:Run pre-flight project validation checks'` and `'changelog:Generate changelog from completed tasks'`. Run `pnpm typecheck`. Criterion #1 (complete tab completion — all 25 commands discoverable)
**Status:** completed
**Started:** 2026-02-20 03:02
**Completed:** 2026-02-20
**Branch:** dev/add-validate-changelog-and---from-snapsh
**Worker:** 3

### Changes
-- See git log for details
