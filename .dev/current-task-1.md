# Current Task
## [FIX] Fix CLI scripts path resolution for npm package distribution — packages/cli/src/commands/init.ts line 7 resolves SKYNET_ROOT via `resolve(__dirname, "../../../..")` which only works inside the monorepo. When installed from npm, scripts/ won't be at that path. Fix: add `"files": ["dist", "scripts"]` to packages/cli/package.json so scripts ship with the tarball, then change SKYNET_ROOT resolution to use `fileURLToPath(new URL('../../scripts', import.meta.url))` pattern (relative to the compiled dist/commands/init.js). Verify `npm pack` includes scripts/ and that init.ts can locate them. Also add `"prepublishOnly": "tsc"` to packages/cli/package.json
**Status:** completed
**Started:** 2026-02-19 15:09
**Completed:** 2026-02-19
**Branch:** dev/fix-cli-scripts-path-resolution-for-npm-
**Worker:** 1

### Changes
-- See git log for details
