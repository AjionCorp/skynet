# Current Task
## [FIX] Replace `&>/dev/null` bashism with portable `>/dev/null 2>&1` in 8 script locations — `&>` is a bashism that redirects both stdout and stderr. While bash 3.2 supports it, the project's shell rules mandate bash 3.2 compatibility and the rest of the codebase uses `>/dev/null 2>&1` exclusively. The 8 locations: `scripts/auth-check.sh` lines 14 and 106, `scripts/agents/claude.sh` line 14, `scripts/agents/codex.sh` line 14, `scripts/_agent.sh` lines 37, 94, and 161, `scripts/_compat.sh` line 62. Also in `scripts/_compat.sh` line 7, replace `[[ "$(uname -s)" == "Darwin" ]]` with `[ "$(uname -s)" = "Darwin" ]` for POSIX consistency (this is the only `[[` in the codebase outside the already-fixed `watchdog.sh`). Fix: global find-and-replace `&>/dev/null` with `>/dev/null 2>&1` in these files. Run `bash -n` on all modified files and `pnpm typecheck`. Criterion #1 (portability — consistent bash 3.2 style)
**Status:** completed
**Started:** 2026-02-20 02:49
**Completed:** 2026-02-20
**Branch:** dev/replace-devnull-bashism-with-portable-de
**Worker:** 2

### Changes
-- See git log for details
