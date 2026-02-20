# Current Task
## [FIX] Replace `[[` with `case` in watchdog.sh for bash 3.2 style consistency — in `scripts/watchdog.sh` line 529, inside `_cleanup_stale_branches()`: `[[ "$branch" == dev/* ]] || continue`. While `[[` technically works in bash 3.2, the project's shell rules state bash 3.2 compatibility and the rest of the codebase uses `[ ... ]` exclusively. This is the only `[[` usage in the pipeline scripts (except `_compat.sh` for platform detection). Fix: replace with a `case` statement: `case "$branch" in dev/*) ;; *) continue ;; esac`. Run `bash -n scripts/watchdog.sh` and `pnpm typecheck` to verify. Criterion #1 (portability — consistent bash 3.2 style across all scripts)
**Status:** completed
**Started:** 2026-02-20 01:51
**Completed:** 2026-02-20
**Branch:** dev/-continue-while--technically-works-in-ba
**Worker:** 4

### Changes
-- See git log for details
