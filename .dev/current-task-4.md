# Current Task
## [FIX] Add missing KNOWN_VARS entries for SKYNET_WORKER_CONTEXT, SKYNET_WORKER_CONVENTIONS, and SKYNET_WATCHDOG_INTERVAL — in `packages/cli/src/commands/config.ts` lines 11-59, the `KNOWN_VARS` dictionary (used for `skynet config list` descriptions) is missing 3 config variables that exist in the real config and are referenced in pipeline scripts. Add before the closing brace: `SKYNET_WORKER_CONTEXT: "Path to file with project-specific context injected into worker prompts"`, `SKYNET_WORKER_CONVENTIONS: "Path to file with coding conventions injected into worker prompts"`, `SKYNET_WATCHDOG_INTERVAL: "Seconds between watchdog monitoring cycles (default: 180)"`. This makes `skynet config list` show descriptions for ALL variables. Run `pnpm typecheck`. Criterion #1 (accurate developer tooling — no blank description rows)
**Status:** completed
**Started:** 2026-02-20 01:52
**Completed:** 2026-02-20
**Branch:** dev/add-missing-knownvars-entries-for-skynet
**Worker:** 4

### Changes
-- See git log for details
