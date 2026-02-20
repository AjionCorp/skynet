# Current Task
## [INFRA] Centralize failed-task markdown field codec into one shared shell path — in `scripts/_config.sh`, expose canonical encode/decode helpers for failed-task table fields (pipes, backticks, escaped newlines) and migrate `scripts/task-fixer.sh` plus `scripts/watchdog.sh` to exclusively use those helpers for all reads/writes. Mission: Criterion #3 deterministic state and Criterion #2 retry-loop stability.
**Status:** completed
**Started:** 2026-02-20 17:59
**Completed:** 2026-02-20
**Branch:** dev/centralize-failed-task-markdown-field-co
**Worker:** 1

### Changes
-- See git log for details
