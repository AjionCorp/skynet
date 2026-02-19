# Current Task
## [INFRA] Add ESLint with TypeScript support to CI pipeline — install `eslint`, `@typescript-eslint/eslint-plugin`, `@typescript-eslint/parser` as root workspace devDependencies. Create `eslint.config.js` (flat config) extending recommended TypeScript rules, ignoring `dist/`, `node_modules/`, `.next/`. Add `"lint:ts": "eslint packages/*/src/"` to root `package.json`. Add `lint-ts` job to `.github/workflows/ci.yml`. Start with `warn` severity to avoid blocking existing code. Criterion #2 (catching type and quality bugs before merge)
**Status:** completed
**Started:** 2026-02-19 18:08
**Completed:** 2026-02-19
**Branch:** dev/add-eslint-with-typescript-support-to-ci
**Worker:** 4

### Changes
-- See git log for details
