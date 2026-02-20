# Current Task
## [TEST] Add `status.test.ts` CLI unit test — `status.ts` is the most complex CLI command (400+ lines) with zero dedicated tests. Create `packages/cli/src/commands/__tests__/status.test.ts`. Mock `fs.readFileSync` for all `.dev/` state files (backlog.md, completed.md, failed-tasks.md, current-task-N.md, worker-N.heartbeat, skynet.config.sh). Test: (a) `--json` flag outputs valid JSON matching `{ project, paused, tasks, workers, healthScore, selfCorrectionRate, missionProgress, lastActivity }` shape, (b) `--quiet` flag outputs only the health score number, (c) health score calculation returns 100 with no failures/blockers/stale heartbeats, (d) health score deductions are correct (5 per pending failure, 10 per blocker, 2 per stale heartbeat), (e) worker heartbeat detection loops through all N workers (not just 2), (f) mission progress parsing shows all 6 criteria. Follow patterns in existing CLI tests (`init.test.ts`, `doctor.test.ts`). Criterion #2
**Status:** completed
**Started:** 2026-02-20 00:32
**Completed:** 2026-02-20
**Branch:** dev/add-statustestts-cli-unit-test--statusts
**Worker:** 1

### Changes
-- See git log for details
