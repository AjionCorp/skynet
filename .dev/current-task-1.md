# Current Task
## [FIX] Close blocked Codex prompt root with exact repro+guard test — use `.dev/blockers.md` repro to patch `scripts/agents/codex.sh` so stdin-first prompt delivery and child exit-code propagation are both preserved through `_agent_exec`, then add/update shell regression for >300KB prompt payloads and run `pnpm typecheck`. Mission: Criterion #6 multi-agent compatibility and Criterion #2 retry-loop closure.
**Status:** completed
**Started:** 2026-02-20 10:43
**Completed:** 2026-02-20
**Branch:** dev/close-blocked-codex-prompt-root-with-exa
**Worker:** 1

### Changes
-- See git log for details
