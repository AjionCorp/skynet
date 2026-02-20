# Current Task
## [INFRA] Add typecheck and test steps to publish-cli.yml before npm publish — in `.github/workflows/publish-cli.yml`, the publish job runs `pnpm build` and checks that `dist/index.js` exists, but does NOT run `pnpm typecheck` or `pnpm test` before publishing. A developer can push a `cli-v*` tag on a commit with failing tests and the broken version ships to npm. Fix: add two steps before the publish step: (1) `pnpm typecheck` to catch type errors, (2) `pnpm --filter @ajioncorp/skynet-cli test` to run CLI unit tests. If either fails, the publish is blocked. This prevents broken CLI releases from reaching users via `npx skynet init`. Run `pnpm typecheck`. Criterion #2 (CI quality gates prevent broken releases)
**Status:** completed
**Started:** 2026-02-20 02:20
**Completed:** 2026-02-20
**Branch:** dev/add-typecheck-and-test-steps-to-publish-
**Worker:** 1

### Changes
-- See git log for details
