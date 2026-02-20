# Current Task
## [FIX] Fix stale lock recovery using wrong backlog marker causing 0m re-executions — in `scripts/dev-worker.sh` line 336, when stale lock detection triggers, the code calls `remove_from_backlog "- [ ] $task_title"` but by that point the task is marked `[>]` (claimed), not `[ ]` (pending). Since `remove_from_backlog` does an exact match via `grep -Fxv`, the remove silently fails. The `[>]` entry persists, watchdog later unclaims it back to `[ ]`, and the task re-executes with "0m" duration because the implementation already exists. Fix: change line 336 from `remove_from_backlog "- [ ] $task_title"` to `remove_from_backlog "- [>] $task_title"`. Also add a fallback: if the `[>]` match fails, try `[x]` in case it was already marked done by another code path. Run `pnpm typecheck`. Criterion #3 (no duplicate executions — directly explains the 0m duration entries in completed.md)
**Status:** completed
**Started:** 2026-02-20 01:40
**Completed:** 2026-02-20
**Branch:** dev/tasktitle-also-add-a-fallback-if-the--ma
**Worker:** 2

### Changes
-- See git log for details
