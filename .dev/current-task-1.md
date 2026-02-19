# Current Task
## [FIX] Inject previous failure context into task-fixer retry prompts — in scripts/task-fixer.sh, when building the Claude Code prompt for a retry, read the last 100 lines of the failed branch's worker log (`$SCRIPTS_DIR/dev-worker-*.log`) and include the error output in the prompt under a "## Previous Failure" section. Also include the git diff of what was changed on the failed branch (`git diff main...$BRANCH`). This gives Claude maximum context to fix the issue on retry, directly improving the self-correction success rate
**Status:** completed
**Started:** 2026-02-19 16:43
**Completed:** 2026-02-19
**Branch:** dev/inject-previous-failure-context-into-tas
**Worker:** 1

### Changes
-- See git log for details
