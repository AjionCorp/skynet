# Current Task
## [FIX] Add `tg` notification and `emit_event` when task-fixer escalates task to blocked — in `scripts/task-fixer.sh` lines 231-236, when `fix_attempts >= MAX_FIX_ATTEMPTS`, the script marks the task as `blocked` in failed-tasks.md and writes to blockers.md, but sends NO notification and emits NO event. Humans are never alerted when a task is permanently blocked. Fix: after line 234 (the `echo >> "$BLOCKERS"` line), add two lines: `tg "🚫 *${SKYNET_PROJECT_NAME_UPPER} TASK-FIXER F${FIXER_ID}* task BLOCKED after $MAX_FIX_ATTEMPTS attempts — $task_title"` and `emit_event "task_blocked" "Fixer $FIXER_ID: $task_title (max attempts)"`. Run `pnpm typecheck`. Criterion #2 (self-correction visibility) and #4 (dashboard event coverage)
**Status:** completed
**Started:** 2026-02-20 01:25
**Completed:** 2026-02-20
**Branch:** dev/add-tg-notification-and-emitevent-when-t
**Worker:** 1

### Changes
-- See git log for details
