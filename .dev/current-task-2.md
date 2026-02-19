# Current Task
## [FEAT] Add `skynet logs` CLI command — create packages/cli/src/commands/logs.ts. Accept subcommand for log type: `skynet logs worker [--id N]` (reads .dev/scripts/dev-worker-N.log), `skynet logs fixer`, `skynet logs watchdog`, `skynet logs health-check`. Support `--tail N` (default 50 lines) and `--follow` (uses `fs.watch` + readline to stream new lines). If no subcommand given, list available log files with their sizes and last-modified times. Register in packages/cli/src/index.ts
**Status:** completed
**Started:** 2026-02-19 16:51
**Completed:** 2026-02-19
**Branch:** dev/add-skynet-logs-cli-command--create-pack
**Worker:** 2

### Changes
-- See git log for details
