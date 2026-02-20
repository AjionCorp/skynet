# Current Task
## [FEAT] Add `skynet run` CLI command for one-shot task execution — create `packages/cli/src/commands/run.ts`. Usage: `skynet run "Implement feature X" --agent claude --gate typecheck`. Spawns a single worker that claims a temporary task (not from backlog), runs the agent, executes the quality gate, and merges to main if passed. Useful for quick one-off tasks without adding to the backlog. Create a temp `current-task-run.md`, run through the same `dev-worker.sh` pipeline but with `SKYNET_ONE_SHOT=true` env var that skips the claim loop. Register in `packages/cli/src/index.ts`. Criterion #1 (developer experience — quick task execution without backlog ceremony)
**Status:** completed
**Started:** 2026-02-19 22:10
**Completed:** 2026-02-19
**Branch:** dev/add-skynet-run-cli-command-for-one-shot-
**Worker:** 3

### Changes
-- See git log for details
