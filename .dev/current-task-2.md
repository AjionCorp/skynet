# Current Task
## [FIX] Add `worker` field to `EventEntry` interface and display in dashboard — in `packages/dashboard/src/types.ts` line 257, `EventEntry` only has `ts`, `event`, `detail`. But `scripts/_events.sh` emits `{"ts":"ISO","event":"type","worker":N,"detail":"text"}` — the `worker` field is silently dropped during deserialization. Fix: (1) add `worker?: number;` to `EventEntry` interface. (2) In `packages/dashboard/src/handlers/events.ts`, include `worker` when parsing event JSON lines. (3) In `packages/dashboard/src/components/ActivityFeed.tsx`, show "W{N}" badge next to each event when worker is present. (4) In `packages/dashboard/src/components/EventsDashboard.tsx`, add Worker column to the events table. Run `pnpm typecheck`. Criterion #4 (complete event visibility — know which worker performed each action)
**Status:** completed
**Started:** 2026-02-20 03:04
**Completed:** 2026-02-20
**Branch:** dev/add-worker-field-to-evententry-interface
**Worker:** 2

### Changes
-- See git log for details
