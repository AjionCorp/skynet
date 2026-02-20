# Current Task
## [FIX] Pass agent prompt via stdin instead of CLI argument to avoid ARG_MAX — in `scripts/agents/claude.sh` line 39, the prompt is passed as a direct CLI argument: `_agent_exec $SKYNET_CLAUDE_BIN $SKYNET_CLAUDE_FLAGS "$prompt"`. On macOS, `ARG_MAX` is ~1MB. With large `SKYNET_WORKER_CONTEXT` and `SKYNET_WORKER_CONVENTIONS` config values, the prompt can exceed this limit. Fix: change the invocation to pipe the prompt via stdin: `echo "$prompt" | _agent_exec $SKYNET_CLAUDE_BIN $SKYNET_CLAUDE_FLAGS --print -` or write to a temp file and pass via `cat`. Check the `_agent_exec` function in `scripts/_agent.sh` to ensure stdin piping is compatible. If using a temp file, ensure it's cleaned up in the trap handler. Test with a large prompt string (>500KB) to verify. Run `pnpm typecheck`. Criterion #3 (reliability — prevents silent failures on large projects with extensive conventions)
**Status:** completed
**Started:** 2026-02-20 01:51
**Completed:** 2026-02-20
**Branch:** dev/pass-agent-prompt-via-stdin-instead-of-c
**Worker:** 4

### Changes
-- See git log for details
