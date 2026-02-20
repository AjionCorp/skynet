# Current Task
## [INFRA] Add SSE auto-reconnection with backoff to PipelineDashboard — in `packages/dashboard/src/components/PipelineDashboard.tsx`, the `EventSource` SSE connection has no reconnection handling — if the server restarts or network blips, the dashboard silently stops updating. Add: (a) `onerror` handler that closes the failed connection and schedules a reconnect with exponential backoff (1s → 2s → 4s → 8s, max 30s), (b) reset backoff timer on successful `onmessage`, (c) add a `connectionStatus` state variable ('connected' | 'reconnecting' | 'disconnected') displayed as a small colored indicator (green/yellow/red dot) next to the page title, (d) handle `document.visibilitychange` — close SSE when tab is hidden, reopen when visible to save server resources. Keep the existing polling fallback intact for browsers that don't support SSE. Criterion #4 (reliable real-time dashboard visibility)
**Status:** completed
**Started:** 2026-02-20 01:02
**Completed:** 2026-02-20
**Branch:** dev/add-sse-auto-reconnection-with-backoff-t
**Worker:** 2

### Changes
-- See git log for details
