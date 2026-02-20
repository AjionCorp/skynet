# Current Task
## [FIX] Read CLI version from package.json instead of hardcoding "0.1.0" — in `packages/cli/src/index.ts` line 34, `.version("0.1.0")` is hardcoded. When `package.json` version is bumped for a release, `skynet --version` (Commander's built-in flag) will show the stale "0.1.0" instead of the actual version. The separate `version.ts` command reads from package.json correctly, but the Commander `.version()` registration does not. Fix: at the top of `index.ts`, import `createRequire` from `"module"`, then `const require = createRequire(import.meta.url); const pkg = require("../package.json");` and change `.version("0.1.0")` to `.version(pkg.version)`. This is the same pattern used by the `version.ts` command. Run `pnpm typecheck`. Criterion #1 (accurate CLI — version must match published package)
**Status:** completed
**Started:** 2026-02-20 02:47
**Completed:** 2026-02-20
**Branch:** dev/read-cli-version-from-packagejson-instea
**Worker:** 4

### Changes
-- See git log for details
