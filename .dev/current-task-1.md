# Current Task
## [INFRA] Extend watchdog stale branch cleanup to handle fixed and superseded tasks — FRESH implementation (previous branch `dev/extend-watchdog-stale-branch-cleanup-to-` has merge conflict — delete it). The existing `_cleanup_stale_branches()` in `scripts/watchdog.sh` only handles entries with `status=blocked`. Extend it to also delete branches for entries with `status=fixed` or `status=superseded`. Also add logic to detect when a failed-task entry with `status=pending` has a matching task title in completed.md (completed via fresh implementation), and auto-mark those entries as `status=superseded`. Currently 10 stale dev/* branches exist — after this change, the watchdog should clean most of them up. Criterion #3 (clean state, no zombie branches)
**Status:** completed
**Started:** 2026-02-19 18:16
**Completed:** 2026-02-19
**Branch:** dev/extend-watchdog-stale-branch-cleanup-to-
**Worker:** 1

### Changes
-- See git log for details
