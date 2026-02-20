# Current Task
## [FIX] Validate git repository during `skynet init` — in `packages/cli/src/commands/init.ts`, the `initCommand()` function creates `.dev/` and copies scripts without checking if the current directory is inside a git repository. If a user runs `npx skynet init` in a non-git directory, the pipeline will fail on first task claim when `git worktree add` is called with a confusing low-level error. Fix: at the start of `initCommand()`, before any file operations, run `execSync("git rev-parse --is-inside-work-tree", { stdio: "pipe" })` in a try/catch. If it fails, print a clear error: "Error: skynet init must be run from within a git repository. Run 'git init' first." and `process.exit(1)`. Also verify the repo has at least one commit via `execSync("git rev-parse HEAD", { stdio: "pipe" })` since `git worktree` requires it — if no commits exist, print "Error: git repository must have at least one commit. Run 'git add -A && git commit -m initial' first." Run `pnpm typecheck`. Criterion #1 (clear errors during setup — catches misconfiguration before pipeline starts)
**Status:** completed
**Started:** 2026-02-20 02:32
**Completed:** 2026-02-20
**Branch:** dev/validate-git-repository-during-skynet-in
**Worker:** 3

### Changes
-- See git log for details
