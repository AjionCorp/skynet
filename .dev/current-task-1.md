# Current Task
## [FIX] Fix pipeline-status.ts `handlerCount` always returning 0 in production builds — in `packages/dashboard/src/handlers/pipeline-status.ts` lines 546-553, handler counting uses `readdir(handlersDir).filter((f) => f.endsWith(".ts") && !f.includes(".test."))`. In production Next.js builds, `__dirname` points to compiled output containing `.js` files, not `.ts`. The filter matches zero files, so `handlerCount` is always 0, breaking mission criterion #1 and #4 evaluation. Fix: change the filter to check for both extensions: `f.endsWith(".ts") || f.endsWith(".js")` and exclude both `.test.ts` and `.test.js`. Alternatively, hardcode the handler count as a known constant (currently 10 handlers) since it changes rarely and counting compiled files is inherently fragile. Run `pnpm typecheck` and `pnpm build` to verify. Criterion #4 (dashboard shows correct mission progress in production)
**Status:** completed
**Started:** 2026-02-20 02:20
**Completed:** 2026-02-20
**Branch:** dev/fix-pipeline-statusts-handlercount-alway
**Worker:** 1

### Changes
-- See git log for details
