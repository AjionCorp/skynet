# Current Task
## [FIX] Fix is_task_blocked() to also check completed.md for dependency resolution — in `scripts/dev-worker.sh` lines 121-141, `is_task_blocked()` only checks for `[x]` markers in `$BACKLOG` to determine if a dependency is done. Once old `[x]` entries are cleaned from the backlog (or after a completed.md archival), a dependency that was genuinely completed won't match, and the dependent task stays blocked forever. Fix: after line 136 (`if ! grep -q "^\- \[x\] .*${dep}" "$BACKLOG"...`), add a fallback check: `if [ -f "$COMPLETED" ] && grep -qF "$dep" "$COMPLETED" 2>/dev/null; then continue; fi`. This mirrors the same pattern already used in `_config.sh:229-233` for `validate_backlog()`. Run `pnpm typecheck`. Criterion #3 (correct dependency resolution — prevents tasks from getting stuck)
**Status:** completed
**Started:** 2026-02-20 01:43
**Completed:** 2026-02-20
**Branch:** dev/-grep--qf-dep-completed-2devnull-then-co
**Worker:** 1

### Changes
-- See git log for details
