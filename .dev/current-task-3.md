# Current Task
## [INFRA] Enhance `skynet doctor` with runtime consistency checks — in `packages/cli/src/commands/doctor.ts`, add new checks: (1) **Worker count match** — read `SKYNET_MAX_WORKERS` from config, count actual running worker PID files, warn if mismatch. (2) **Orphaned worktrees** — run `git worktree list`, flag any worktrees that don't match an active worker's branch. (3) **Backlog integrity** — read backlog.md, check for duplicate task titles in pending `[ ]` entries, check that all `[>]` claimed tasks have a matching `current-task-N.md` in `in_progress` state. (4) **Stale heartbeats** — read worker-N.heartbeat files, warn if any are older than SKYNET_STALE_MINUTES. (5) **Config completeness** — verify all required SKYNET_* variables are set and non-empty. Output severity as PASS/WARN/FAIL per check
**Status:** completed
**Started:** 2026-02-19 17:50
**Completed:** 2026-02-19
**Branch:** dev/enhance-skynet-doctor-with-runtime-consi
**Worker:** 3

### Changes
-- See git log for details
