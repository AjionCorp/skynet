# Current Task
## [FIX] Add missing handler and type exports to `packages/dashboard/src/index.ts` — the root `index.ts` handler export block (lines 41-54) is missing `createEventsHandler` and `createMissionRawHandler` which were added after the initial block was written. The type export block (lines 2-29) is missing `SelfCorrectionStats` and `EventEntry`. Fix: add `createEventsHandler` and `createMissionRawHandler` to the handler re-export block. Add `SelfCorrectionStats` and `EventEntry` to the type re-export block. These are needed by external consumers importing from `@ajioncorp/skynet` root path (the admin app uses sub-path imports so it works, but any external Next.js app embedding the dashboard would get undefined). Run `pnpm typecheck`. Criterion #1 (correct npm package API surface)
**Status:** completed
**Started:** 2026-02-20 01:25
**Completed:** 2026-02-20
**Branch:** dev/add-missing-handler-and-type-exports-to-
**Worker:** 4

### Changes
-- See git log for details
