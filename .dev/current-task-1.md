# Current Task
## [TEST] Add mission-raw and pipeline-stream handler unit tests — create `packages/dashboard/src/handlers/mission-raw.test.ts`: test it reads and returns `.dev/mission.md` raw content, test missing file returns appropriate error/empty response, test response shape matches expected interface. Create `packages/dashboard/src/handlers/pipeline-stream.test.ts`: test SSE headers are set correctly (`text/event-stream`, `no-cache`), test file-watch setup is called (mock `fs.watch`), test stream sends data in SSE format (`data: {...}\n\n`), test cleanup on client disconnect. Follow existing handler test patterns. These are the last 2 untested handlers in the dashboard package. Criterion #2 (complete handler test coverage)
**Status:** completed
**Started:** 2026-02-19 21:16
**Completed:** 2026-02-19
**Branch:** dev/add-mission-raw-and-pipeline-stream-hand
**Worker:** 1

### Changes
-- See git log for details
