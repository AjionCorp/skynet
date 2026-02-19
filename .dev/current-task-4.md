# Current Task
## [FEAT] Add `skynet pause` and `skynet resume` CLI commands — FRESH implementation (previous branch `dev/add-skynet-pause-and-skynet-resume-cli-c` has merge conflict — delete it). Create `packages/cli/src/commands/pause.ts`: writes a `.dev/pipeline-paused` sentinel file with `{ "pausedAt": "ISO timestamp", "pausedBy": "user" }`. Create `packages/cli/src/commands/resume.ts`: removes the sentinel file. In `scripts/dev-worker.sh`, after PID lock acquisition, check `if [ -f "$DEV_DIR/pipeline-paused" ]; then log "Pipeline paused — exiting"; exit 0; fi`. Same check in `scripts/task-fixer.sh` and `scripts/project-driver.sh`. In `scripts/watchdog.sh`, skip worker dispatch when paused but still run health checks and stale detection. In `packages/cli/src/commands/status.ts`, show "PAUSED" status when sentinel exists. Register both commands in `packages/cli/src/index.ts`
**Status:** completed
**Started:** 2026-02-19 18:12
**Completed:** 2026-02-19
**Branch:** dev/add-skynet-pause-and-skynet-resume-cli-c
**Worker:** 4

### Changes
-- See git log for details
