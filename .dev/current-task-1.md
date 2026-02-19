# Current Task
## [FEAT] Add `skynet dashboard` CLI command to launch admin app — create packages/cli/src/commands/dashboard.ts. Resolve admin package path relative to skynet root (same pattern as init.ts). Run `pnpm --filter admin dev -- --port <PORT>` via child_process.spawn with stdio inherit. Default port 3100 (configurable via --port flag). Open browser automatically via `open` (macOS) or `xdg-open` (Linux). Register in packages/cli/src/index.ts
**Status:** completed
**Started:** 2026-02-19 16:54
**Completed:** 2026-02-19
**Branch:** dev/add-skynet-dashboard-cli-command-to-laun
**Worker:** 1

### Changes
-- See git log for details
