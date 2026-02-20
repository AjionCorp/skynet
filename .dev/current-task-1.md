# Current Task
## [FEAT] Wire emit_event() calls into dev-worker.sh, task-fixer.sh, and watchdog.sh — THIRD attempt (delete stale branch `dev/wire-emitevent-calls-into-dev-workersh-t` first via `git branch -D`). The `emit_event` function is in `scripts/_events.sh` (already sourced via `_config.sh`), format: `emit_event "event_name" "description"`. Add exactly these 9 one-liner calls: **dev-worker.sh**: (1) After line 390 (`tg "🔨 *$SKYNET_PROJECT_NAME_UPPER..."`): `emit_event "task_claimed" "Worker $WORKER_ID: $task_title"`. (2) At line 463 (`tg "❌ *$SKYNET_PROJECT_NAME_UPPER W${WORKER_ID} FAILED*..."`): add `emit_event "task_failed" "Worker $WORKER_ID: $task_title"`. (3) At line 505 (gate failed `tg "❌..."`): add `emit_event "task_failed" "Worker $WORKER_ID: $task_title (gate: $_gate_label)"`. (4) At line 590 (`tg "✅ *$SKYNET_PROJECT_NAME_UPPER W${WORKER_ID} MERGED*..."`): add `emit_event "task_completed" "Worker $WORKER_ID: $task_title"`. **task-fixer.sh**: (5) Before the fix agent runs, add `emit_event "fix_started" "Fixer $FIXER_ID: $TASK_TITLE"`. (6) After successful fix merge, add `emit_event "fix_succeeded" "Fixer $FIXER_ID: $TASK_TITLE"`. (7) On fix failure, add `emit_event "fix_failed" "Fixer $FIXER_ID: $TASK_TITLE"`. **watchdog.sh**: (8) When killing a stale worker, add `emit_event "worker_killed" "Killed stale worker $wid"`. (9) When cleaning a branch, add `emit_event "branch_cleaned" "Cleaned $branch"`. No new files, no TypeScript changes. Just add these one-liner bash calls. Run `pnpm typecheck` to verify nothing broke. Criterion #4
**Status:** completed
**Started:** 2026-02-20 00:19
**Completed:** 2026-02-20
**Branch:** dev/wire-emitevent-calls-into-dev-workersh-t
**Worker:** 1

### Changes
-- See git log for details
