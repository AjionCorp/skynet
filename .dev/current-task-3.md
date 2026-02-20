# Current Task
## [FEAT] Add config auto-migration to detect and add new variables on upgrade — in `packages/cli/src/commands/config.ts`, add a `migrate` subcommand: `skynet config migrate`. Reads the installed template (`templates/skynet.config.sh` relative to CLI package) and the user's `.dev/skynet.config.sh`. For each `SKYNET_*` variable defined in the template that is absent from the user's config, append it with its default value and preceding comment (copy the template's comment block). Print "Added N new config variables: VAR1, VAR2, ...". If all variables exist, print "Config is up to date". Also wire this into `packages/cli/src/commands/upgrade.ts` — after a successful npm upgrade, automatically run config migration and report results. This solves the "silent missing config" problem when users upgrade and new config variables (like `SKYNET_HEALTH_ALERT_THRESHOLD`, `SKYNET_AGENT_TIMEOUT_MINUTES`) were added in the newer version. Criterion #1 (smooth upgrade path)
**Status:** completed
**Started:** 2026-02-20 01:02
**Completed:** 2026-02-20
**Branch:** dev/add-config-auto-migration-to-detect-and-
**Worker:** 3

### Changes
-- See git log for details
