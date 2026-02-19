# Current Task
## [FEAT] Add worker activity log rotation — in scripts/dev-worker.sh and task-fixer.sh, before starting a new task cycle, check if the log file exceeds 1MB. If so, rotate: rename current log to `$LOG.1`, remove `$LOG.2` if it exists (keep max 2 rotations). This prevents log files from growing unbounded during long pipeline runs. Add SKYNET_MAX_LOG_SIZE_KB=1024 to skynet.config.sh
**Status:** completed
**Started:** 2026-02-19 17:01
**Completed:** 2026-02-19
**Branch:** dev/add-worker-activity-log-rotation--in-scr
**Worker:** 3

### Changes
-- See git log for details
