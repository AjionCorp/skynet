# Current Task
## [FIX] Fix health-check.sh unquoted `$SKYNET_LINT_CMD` causing word splitting — in `scripts/health-check.sh` line 102, `if $SKYNET_LINT_CMD >> "$LOG" 2>&1` expands without quotes. If the user sets `SKYNET_LINT_CMD="pnpm run lint"`, word splitting treats each space-separated token as a separate argument to the first token, breaking the command with confusing "command not found" errors. The quality gates in `dev-worker.sh` use `eval "$_gate_cmd"` which handles the full string as a shell command. Fix: change line 102 from `if $SKYNET_LINT_CMD >> "$LOG" 2>&1` to `if eval "$SKYNET_LINT_CMD" >> "$LOG" 2>&1`. Apply the same fix to `$SKYNET_TYPECHECK_CMD` if it has the same pattern anywhere in the file. Run `bash -n scripts/health-check.sh` and `pnpm typecheck`. Criterion #1 (portability — commands with spaces must work)
**Status:** completed
**Started:** 2026-02-20 02:21
**Completed:** 2026-02-20
**Branch:** dev/fix-health-checksh-unquoted-skynetlintcm
**Worker:** 4

### Changes
-- See git log for details
