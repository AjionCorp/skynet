# Current Task
## [DOCS] Add CONTRIBUTING.md with agent plugin and extension guide — create `CONTRIBUTING.md` at repo root. Sections: (1) **Development Setup** — clone, `pnpm install`, `pnpm dev:admin`. (2) **Creating Custom Agent Plugins** — explain `scripts/agents/` interface: create `my-agent.sh` exporting `run_agent()` that takes prompt + logfile, set `SKYNET_AGENT_PLUGIN="my-agent"` in config. Show the contract from `scripts/agents/claude.sh`. (3) **Adding Notification Channels** — explain `scripts/notify/` plugin structure, show how to add e.g. `email.sh` matching telegram.sh pattern, add to `SKYNET_NOTIFY_CHANNELS`. (4) **Custom Quality Gates** — explain `SKYNET_GATE_N` pattern in config. (5) **Dashboard Development** — handler pattern (`createXxxHandler(config)`), component pattern (fetch from API, display), adding admin pages. (6) **Shell Script Rules** — bash 3.2 compat, mkdir locks, source _config.sh, race conditions. Keep under 150 lines. Criterion #1 (developer experience for adopters)
**Status:** completed
**Started:** 2026-02-19 22:03
**Completed:** 2026-02-19
**Branch:** dev/add-contributingmd-with-agent-plugin-and
**Worker:** 1

### Changes
-- See git log for details
