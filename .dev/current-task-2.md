# Current Task
## [FIX] Add `SKYNET_WORKER_CONTEXT` and `SKYNET_WORKER_CONVENTIONS` as commented-out examples in config template — `dev-worker.sh` line 461 uses `${SKYNET_WORKER_CONTEXT:-}` and line 482 uses `${SKYNET_WORKER_CONVENTIONS:-}` for injecting project-specific context and coding conventions into agent prompts. `task-fixer.sh` line 382 also uses `${SKYNET_WORKER_CONVENTIONS:-}`. These are documented in `KNOWN_VARS` (config.ts lines 59-60) but NOT in `templates/skynet.config.sh`, making them completely undiscoverable to users. Fix: add after the Agent Plugin section (after line 85 in the template) as commented-out examples: `# export SKYNET_WORKER_CONTEXT=""  # Path to file with project-specific context injected into agent prompts` and `# export SKYNET_WORKER_CONVENTIONS=""  # Path to file with coding conventions injected into agent prompts`. Run `pnpm typecheck`. Criterion #1 (all config knobs discoverable in the template)
**Status:** completed
**Started:** 2026-02-20 02:31
**Completed:** 2026-02-20
**Branch:** dev/add-skynetworkercontext-and-skynetworker
**Worker:** 2

### Changes
-- See git log for details
