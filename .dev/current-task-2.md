# Current Task
## [FIX] Use `sed_inplace` wrapper in task-fixer.sh instead of raw `sed -i.bak` — in `scripts/task-fixer.sh`, two locations (lines 165 and 389) use `sed -i.bak ... "$FAILED"; rm -f "$FAILED.bak"` to modify failed-tasks.md. The `_compat.sh` module provides `sed_inplace()` specifically for portable sed-in-place editing. The raw `sed -i.bak` pattern creates a `.bak` file that requires manual cleanup — if the process is killed between `sed` and `rm -f`, the `.bak` persists indefinitely. Fix: at line 165, change `sed -i.bak "s/| fixing-${FIXER_ID} |/| pending |/g" "$FAILED"; rm -f "$FAILED.bak"` to `sed_inplace "s/| fixing-${FIXER_ID} |/| pending |/g" "$FAILED"`. Apply the same change at line 389. Run `bash -n scripts/task-fixer.sh` and `pnpm typecheck`. Criterion #1 (portability — use the portable wrapper consistently)
**Status:** completed
**Started:** 2026-02-20 02:48
**Completed:** 2026-02-20
**Branch:** dev/use-sedinplace-wrapper-in-task-fixersh-i
**Worker:** 2

### Changes
-- See git log for details
