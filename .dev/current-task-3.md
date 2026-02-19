# Current Task
## [FEAT] Add Linux cron support to monitoring agents dashboard handler — FRESH implementation (previous branch has merge conflict). In `packages/dashboard/src/handlers/monitoring-agents.ts`, add OS detection via `process.platform`. On `linux`, parse `crontab -l` output for entries between `# BEGIN skynet` / `# END skynet` markers (matching the format written by `packages/cli/src/commands/setup-agents.ts`). Map cron expressions to human-readable intervals (e.g., `*/3 * * * *` -> "Every 3 minutes"). Return the same `AgentInfo[]` response shape. On `darwin`, keep existing `launchctl` logic unchanged. Add a helper `parseCronSchedule(expr: string): { intervalSeconds: number, human: string }`
**Status:** completed
**Started:** 2026-02-19 17:19
**Completed:** 2026-02-19
**Branch:** dev/add-linux-cron-support-to-monitoring-age
**Worker:** 3

### Changes
-- See git log for details
