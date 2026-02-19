# Current Task
## [INFRA] Add `npx skynet init` end-to-end smoke test — create tests/e2e/init-smoke.test.sh. Steps: (1) run `npm pack` in packages/cli, (2) create temp directory, init git repo, (3) install the tarball via npm, (4) run `npx skynet init --name test-project --dir $TMPDIR` non-interactively, (5) verify .dev/ directory created with all expected files (skynet.config.sh, backlog.md, mission.md, etc.), (6) verify scripts symlinked correctly, (7) cleanup. Add `"test:e2e:cli": "bash tests/e2e/init-smoke.test.sh"` to root package.json
**Status:** completed
**Started:** 2026-02-19 16:59
**Completed:** 2026-02-19
**Branch:** dev/add-npx-skynet-init-end-to-end-smoke-tes
**Worker:** 3

### Changes
-- See git log for details
