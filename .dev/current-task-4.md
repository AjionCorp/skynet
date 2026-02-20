# Current Task
## [INFRA] Add agent-auth preflight gate before watchdog dispatch to avoid dead cycles when credentials expire — in `scripts/watchdog.sh` plus shared auth helpers (`scripts/auth-check.sh`/`scripts/_agent.sh`), detect unauthenticated Claude/Codex sessions before dispatch, emit one throttled `agent_auth_required` event, and skip new claims until auth is restored. Mission: Criterion #2 self-correction continuity and Criterion #3 no-task-loss reliability.
**Status:** completed
**Started:** 2026-02-20 17:12
**Completed:** 2026-02-20
**Branch:** dev/add-agent-auth-preflight-gate-before-wat
**Worker:** 4

### Changes
-- See git log for details
