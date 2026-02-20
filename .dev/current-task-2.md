# Current Task
## [DOCS] Add npm package README for @ajioncorp/skynet-cli — create `packages/cli/README.md`. Sections: (1) **One-line description**: "CLI for Skynet — autonomous AI development pipeline". (2) **Installation**: `npm install -g @ajioncorp/skynet-cli`. (3) **Quick Start**: 4 lines — `skynet init --name my-project`, `skynet setup-agents`, `skynet start`, `skynet watch`. (4) **Commands**: table of all 21 commands (init, setup-agents, start, stop, pause, resume, status, doctor, logs, version, add-task, run, dashboard, reset-task, cleanup, watch, upgrade, metrics, export, config) with brief one-line descriptions. (5) **Configuration**: key `skynet.config.sh` variables (SKYNET_MAX_WORKERS, SKYNET_STALE_MINUTES, SKYNET_AGENT_PLUGIN, SKYNET_GATE_N). (6) **Dashboard**: `skynet dashboard` launches admin UI on port 3100. (7) **Links**: link to main repo README and CONTRIBUTING.md. Keep under 120 lines. Also add `"README.md"` to the `files` array in `packages/cli/package.json` so it ships with the npm tarball. The npm package currently has NO readme — the npmjs.com page is blank. Criterion #1 (developer experience for npm users)
**Status:** completed
**Started:** 2026-02-20 00:31
**Completed:** 2026-02-20
**Branch:** dev/add-npm-package-readme-for-ajioncorpskyn
**Worker:** 2

### Changes
-- See git log for details
