# Current Task
## [FEAT] Add `skynet setup-agents --uninstall` for clean agent removal — in `packages/cli/src/commands/setup-agents.ts`, add `--uninstall` boolean option. On macOS: for each skynet plist file in `~/Library/LaunchAgents/` (matching `com.skynet.*.plist` pattern), run `launchctl unload <path>` then `fs.unlinkSync(path)`. On Linux: read `crontab -l`, remove lines between `# BEGIN skynet` and `# END skynet` markers (inclusive), write back via `crontab -`. Print summary: "Removed N agents (watchdog, health-check, ...)". If no agents found, print "No skynet agents installed". Criterion #1 (complete lifecycle — currently no way to cleanly uninstall agents)
**Status:** completed
**Started:** 2026-02-19 22:02
**Completed:** 2026-02-19
**Branch:** dev/add-skynet-setup-agents---uninstall-for-
**Worker:** 1

### Changes
-- See git log for details
