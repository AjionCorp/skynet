# Current Task
## [FIX] Update config.ts KNOWN_VARS dictionary with missing config variable descriptions — in `packages/cli/src/commands/config.ts`, the `KNOWN_VARS` object (lines 10-53) is missing descriptions for 5 config variables that were added to `templates/skynet.config.sh` after the dictionary was created. Add these entries before the closing brace on line 53: `SKYNET_AGENT_TIMEOUT_MINUTES: "Max minutes before agent process is killed (default: 45)"`, `SKYNET_HEALTH_ALERT_THRESHOLD: "Health score threshold for watchdog alerts (default: 50)"`, `SKYNET_MAX_EVENTS_LOG_KB: "Max events.log size in KB before rotation (default: 1024)"`, `SKYNET_MAX_FIXERS: "Maximum concurrent task-fixer instances (default: 3)"`, `SKYNET_DRIVER_BACKLOG_THRESHOLD: "Pending task count before project-driver generates more (default: 5)"`, `SKYNET_START_DEV_CMD: "Command to start the dev server (optional)"`. This makes `skynet config list` show descriptions for ALL variables instead of blanks for newer ones. Criterion #1 (accurate developer tooling)
**Status:** completed
**Started:** 2026-02-20 01:09
**Completed:** 2026-02-20
**Branch:** dev/update-configts-knownvars-dictionary-wit
**Worker:** 2

### Changes
-- See git log for details
