# Current Task
## [FIX] Fix `sed -n 'Ip'` GNU extension breaking `blockedBy` dependency parsing on macOS — in `scripts/dev-worker.sh` line 125, `sed -n 's/.*| *blockedBy: *\(.*\)$/\1/Ip'` uses the `I` (case-insensitive) flag which is a GNU sed extension NOT available in macOS BSD sed. On macOS (the primary target platform), `blocked_by` is always empty, meaning `is_task_blocked()` never detects blocked tasks — workers attempt blocked tasks immediately, wasting cycles and producing incorrect results. Same issue in `scripts/_config.sh` line 231 inside `validate_backlog()`. Fix: replace `sed -n 's/.*| *blockedBy: *\(.*\)$/\1/Ip'` with `sed -n 's/.*| *[bB]locked[bB]y: *\(.*\)$/\1/p'` (manual case alternation, portable across BSD and GNU sed). Apply to both files. Run `bash -n scripts/dev-worker.sh scripts/_config.sh` and `pnpm typecheck`. Criterion #1 (portability — macOS is the primary platform) and #3 (no wasted worker cycles on blocked tasks)
**Status:** completed
**Started:** 2026-02-20 03:19
**Completed:** 2026-02-20
**Branch:** dev/fix-sed--n-ip-gnu-extension-breaking-blo
**Worker:** 3

### Changes
-- See git log for details
