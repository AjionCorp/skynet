# Current Task
## [FIX] Fix sync-runner.sh bash 3.2 array syntax incompatibility — `scripts/sync-runner.sh` lines 56-57 use `declare -a _sync_names=()` and `declare -a _sync_results=()`, and later iterate with `"${!_sync_names[@]}"` (line ~75) which requires bash 4+ for the `${!}` indirect expansion on indexed arrays. On macOS with bash 3.2 (the default), this silently fails or produces incorrect results. Fix: replace `"${!_sync_names[@]}"` with a counter-based loop: `local _i=0; while [ $_i -lt ${#_sync_names[@]} ]; do ... _i=$((_i + 1)); done`. Also verify no other bash 4+ syntax is used in the file. Run `pnpm typecheck` and `bash -n scripts/sync-runner.sh` with bash 3.2 to verify. Criterion #1 (portability — macOS compatibility is a mission requirement)
**Status:** completed
**Started:** 2026-02-20 01:45
**Completed:** 2026-02-20
**Branch:** dev/fix-sync-runnersh-bash-32-array-syntax-i
**Worker:** 4

### Changes
-- See git log for details
