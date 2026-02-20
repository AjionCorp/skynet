# Current Task
## [FEAT] Add `echo` agent plugin for pipeline dry-run testing — create `scripts/agents/echo.sh` as a minimal agent plugin that echoes the task description back without calling any LLM. On `agent_run()`, create a single commit with a placeholder file containing the task description and "TODO: implement". On `agent_check()`, return success. This lets users run `SKYNET_AGENT_PLUGIN=echo skynet start` to test the full pipeline lifecycle (claim, branch, gate, merge) without burning LLM API tokens. Register in the agent selection logic in `scripts/_agent.sh`. Run `pnpm typecheck` and `bash -n scripts/agents/echo.sh`. Criterion #1 (faster pipeline verification during setup) and #6 (extensible to any agent)
**Status:** completed
**Started:** 2026-02-20 02:07
**Completed:** 2026-02-20
**Branch:** dev/add-echo-agent-plugin-for-pipeline-dry-r
**Worker:** 1

### Changes
-- See git log for details
