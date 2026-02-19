# Current Task
## [FEAT] Add worker heartbeat and stale detection — workers write a timestamp to .dev/worker-N.heartbeat every 60s during task execution (add periodic write in dev-worker.sh main implementation loop). watchdog.sh checks heartbeats on each run: if any heartbeat is older than SKYNET_STALE_MINUTES, kill the worker, unclaim its task in backlog.md, remove the worktree, reset current-task-N.md to idle
**Status:** completed
**Started:** 2026-02-19 14:27
**Completed:** 2026-02-19
**Branch:** dev/add-worker-heartbeat-and-stale-detection
**Worker:** 2

### Changes
-- See git log for details
