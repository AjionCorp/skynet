# Current Task
## [FIX] Fix watchdog `_archive_old_completions` date comparison using `<` in `[ ]` — in `scripts/watchdog.sh` line 495, `[ "$entry_date" < "$cutoff_date" ]` uses `<` inside POSIX `[ ]` test brackets. In POSIX `[ ]`, `<` is the input redirection operator, not a string comparison. Bash's builtin `[` intercepts this, but the behavior is fragile and may create a file named after `$cutoff_date` in the current directory on some systems. Fix: change to `[ "$entry_date" \< "$cutoff_date" ]` (escaped for POSIX) or preferably use a portable comparison: `case` statement or `[ "$(printf '%s\n' "$entry_date" "$cutoff_date" | sort | head -1)" = "$entry_date" ]` and `[ "$entry_date" != "$cutoff_date" ]`. Run `bash -n scripts/watchdog.sh` and `pnpm typecheck`. Criterion #1 (portability — bash 3.2 on macOS)
**Status:** completed
**Started:** 2026-02-20 02:20
**Completed:** 2026-02-20
**Branch:** dev/fix-watchdog-archiveoldcompletions-date-
**Worker:** 3

### Changes
-- See git log for details
