# Current Task
## [INFRA] Add a dedicated failed-task mutex for all writers — introduce `${SKYNET_LOCK_PREFIX}-failed-tasks.lock` helpers in `scripts/_config.sh` and require lock acquisition for every `failed-tasks.md` mutation path in `scripts/task-fixer.sh`, `scripts/watchdog.sh`, and CLI reset flows to prevent interleaved duplicate rows. Mission: Criterion #3 reliability and Criterion #2 retry-loop stability.
**Status:** completed
**Started:** 2026-02-20 10:49
**Completed:** 2026-02-20
**Branch:** dev/add-a-dedicated-failed-task-mutex-for-al
**Worker:** 3

### Changes
-- See git log for details
