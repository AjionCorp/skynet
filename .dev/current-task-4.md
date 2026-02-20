# Current Task
## [FIX] Stabilize Codex large-prompt path with deterministic exit-code preservation — in `scripts/agents/codex.sh`, enforce stdin-first prompt delivery with temp-file fallback only when required, preserve child exit codes through `_agent_exec`, and add `bash -n` plus >300KB regression coverage. Mission: Criterion #6 multi-agent compatibility and Criterion #3 reliability.
**Status:** completed
**Started:** 2026-02-20 09:58
**Completed:** 2026-02-20
**Branch:** dev/stabilize-codex-large-prompt-path-with-d
**Worker:** 4

### Changes
-- See git log for details
