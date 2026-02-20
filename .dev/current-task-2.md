# Current Task
## [INFRA] Add agent execution timeout to prevent zombie agent processes — in `scripts/_agent.sh`, wrap the agent invocation with a configurable timeout. Add `SKYNET_AGENT_TIMEOUT_MINUTES="45"` to `templates/skynet.config.sh`. In the `run_agent()` function (currently in each plugin's `agent_run()`), prefix the agent command with a portable timeout: on Linux use `timeout ${timeout_secs}`, on macOS use `perl -e 'alarm shift; exec @ARGV' ${timeout_secs}` (bash 3.2 compatible, no GNU coreutils dependency). If the agent times out, return exit code 124 (standard timeout convention). In `scripts/dev-worker.sh`, after the agent call (~line 440), detect exit code 124 and log "Agent timed out after ${SKYNET_AGENT_TIMEOUT_MINUTES}m" before marking as failed. In `scripts/task-fixer.sh`, apply the same timeout wrapper. This prevents a single hung agent (network issue, infinite loop, LLM API outage) from blocking a worker slot indefinitely. Criterion #3 (no zombie processes)
**Status:** completed
**Started:** 2026-02-20 00:48
**Completed:** 2026-02-20
**Branch:** dev/add-agent-execution-timeout-to-prevent-z
**Worker:** 2

### Changes
-- See git log for details
