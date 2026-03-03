# Blockers

## Resolved

- **2026-02-19**: Playwright gate ran unconditionally even when `SKYNET_PLAYWRIGHT_DIR` and `SKYNET_SMOKE_TEST` were empty in skynet.config.sh. This caused ALL 10 initial tasks to fail with "playwright tests failed". **Fixed in commit `e317ed1`** — gates now skip when config vars are empty.

- **2026-02-19**: 14 tasks in failed-tasks.md were pending retry by task-fixer after Playwright gate bug. Root cause resolved, most tasks retried and merged.

- **2026-02-19**: npm publish was blocked — CLI `init.ts` resolved scripts via `__dirname` relative to monorepo root, breaking npm installs. **Fixed in commit `1af6dd3`** — uses `import.meta.url` for portable path resolution, also fixed merge conflict markers in CLI files.

- **2026-02-19 21:45**: Mission criterion #2 display bug — `parseMissionProgress()` used `fixedCount / totalFailed` (~14%) instead of `(fixed + superseded) / (fixed + superseded + blocked)` (~97%). **Fixed in commit `0eed9e7`** — criterion #2 now evaluates using the already-computed self-correction variables. All 6 mission criteria display as "met".

- **2026-02-19 21:45**: Events handler tests stuck in `fixing-1` loop due to persistent merge conflicts on `dev/add-events-handler-unit-tests-and-activi` branch. **Fixed** — fresh implementation completed and merged in commit `624d724`. Both `events.test.ts` and `ActivityFeed.test.tsx` now exist on disk.

- **2026-02-20 00:00**: Events pipeline was hollow — bash scripts never called `emit_event()`. **Fixed** — third attempt succeeded, 9 emit_event() calls wired into dev-worker.sh, task-fixer.sh, and watchdog.sh. ActivityFeed now shows live data.

- **2026-02-20 00:00**: 8 stale dev/* branches from superseded failed tasks. **Fixed** — branch cleanup task completed, `git worktree prune` run.

- **2026-02-20 00:00**: README CLI reference table was missing 4 commands (run, watch, upgrade, metrics). **Fixed** — README updated with all 20+ commands.

- **2026-02-20 00:35**: EventsDashboard and `/admin/events` page blocker was stale — task was completed and merged. Removed from active blockers.

- **2026-02-20 06:30**: `check-server-errors.sh` hardcoded `next-dev.log` path. **Fixed** — now accepts optional log path argument, dev-worker.sh passes per-worker log.

- **2026-02-20 06:30**: `sync-runner.sh` pre-flight check hit non-existent `/api/admin/sync-status` route. **Fixed** — changed to `/api/admin/pipeline/status`.

- **2026-02-20 06:30**: `task-fixer.sh` sent no notification when tasks escalated to blocked. **Fixed** — added `tg` notification and `emit_event` on block.

- **2026-02-20 07:30**: **CRITICAL** — Project-driver deduplication did not check `completed.md`. **Fixed in commits `40b81e6`/`9c91756`** — dedup now includes `[x]` backlog entries and all completed.md task titles. No more duplicate task generation.

- **2026-02-20 07:30**: **CRITICAL** — Stale lock recovery used wrong backlog marker `"- [ ]"` instead of `"- [>]"`. **Fixed in commits `673b77f`/`1d0ddc0`** — `remove_from_backlog` now uses correct `[>]` marker with `[x]` fallback. No more 0m re-executions.

- **2026-02-20 07:30**: `completed.md` prompt bloat — 132KB loaded into every project-driver invocation. **Fully fixed** — prompt truncated to last 30 entries, plus archival mechanism added to watchdog (entries >100 and >7 days old moved to `completed-archive.md`).

- **2026-02-20 08:00**: CLI `loadConfig()` regex only matched double-quoted values, causing `SKYNET_MAX_WORKERS=4` to return `undefined`. **Fixed** — `loadConfig()` extracted to shared utility (`packages/cli/src/utils/loadConfig.ts`) with regex `^export\s+(\w+)=(?:"(.*)"|(\S+))` supporting both quoted and unquoted values. 19 duplicate copies eliminated.

- **2026-02-20 08:00**: `task-fixer.sh` had no merge retry/rebase recovery. **Fixed** — same merge-abort → pull → rebase → retry logic as `dev-worker.sh` added.

- **2026-02-20 08:00**: `PipelineDashboard.tsx` dynamic Tailwind class names purged in production. **Fixed** — replaced template literal color construction with static lookup object.

- **2026-02-20 08:00**: `completed.md` archival mechanism added to watchdog. **Fixed** — `_archive_old_completions()` rotates entries >100 to `completed-archive.md`.

- **2026-02-20 10:00**: `skynet init --port` sets `SKYNET_DEV_SERVER_PORT` but runtime uses `SKYNET_DEV_PORT`. **Fixed** — port config variables consolidated, only `SKYNET_DEV_PORT` remains.

- **2026-02-20 10:00**: `auth-check.sh` hardcodes `AUTH_NOTIFY_INTERVAL=3600`. **Fixed** — now reads `SKYNET_AUTH_NOTIFY_INTERVAL` with fallback default.

- **2026-02-20 10:00**: Worker-scaling handler hardcodes `"task-fixer": 3` max. **Fixed** — reads `SKYNET_MAX_FIXERS` from config.

- **2026-02-20 12:00**: TypeScript backlog mutex path missing dash separator. **Fixed** — `tasks.ts` and `pipeline-status.ts` now use `${lockPrefix}-backlog.lock` (with dash), matching bash convention.

- **2026-02-20 12:00**: `task-fixer.sh` and `project-driver.sh` legacy file-based PID locks. **Fixed** — both migrated to mkdir-based atomic locks matching watchdog.sh and dev-worker.sh pattern.

- **2026-02-20 12:00**: Watchdog zombie detection using lock mtime instead of heartbeat. **Fixed** — now checks heartbeat freshness before killing, skips workers with fresh heartbeats.

- **2026-02-20 12:00**: `skynet stop` and `skynet doctor` hardcoded 2-worker lists. **Fixed** — both now dynamically read `SKYNET_MAX_WORKERS` and `SKYNET_MAX_FIXERS` from config.

- **2026-02-20 12:00**: `pipeline-status.ts` `handlerCount` returning 0 in production. **Fixed** — filter now checks both `.ts` and `.js` extensions.

- **2026-02-20 16:00**: CI `lint-sh` job missing pnpm setup. **Fixed** — pnpm/action-setup and setup-node steps added to lint-sh job. Shell scripts are now lint-gated.

- **2026-02-20 16:00**: Worker-scaling handler `unlinkSync` on directory-based locks. **Fixed** — changed to `rmSync` with `{ recursive: true, force: true }`.

- **2026-02-20 20:00**: `completions.ts` COMMANDS object was missing `validate` and `changelog`. **Fixed** — both commands and `--from-snapshot` flag added to completions.

- **2026-02-20 20:00**: `EventEntry` missing `worker` field. **Fixed** — field added, displayed in ActivityFeed and EventsDashboard.

- **2026-02-20 20:00**: README missing 3 CLI commands and 5 dashboard components. **Fixed** — all added.

- **2026-02-20 20:00**: config.ts KNOWN_VARS missing `SKYNET_ONE_SHOT` entries. **Fixed** — both entries added.

- **2026-02-20 20:00**: **CRITICAL** — `pnpm typecheck` failed with 35 TS2741/TS2352 errors in 11 dashboard test files. **Fixed** — `vi.stubGlobal('fetch', ...)` replaced direct `global.fetch =` assignments. Typecheck now passes clean (0 errors).

- **2026-02-20 20:00**: `sed -n 'Ip'` GNU extension breaking blockedBy parsing on macOS. **Fixed** — manual case alternation `[bB]locked[bB]y` applied to dev-worker.sh and _config.sh.

- **2026-02-20 20:00**: CLI `add-task` and `reset-task` missing backlog mutex lock. **Fixed** — `acquireBacklogLock()` utility created and applied to both commands.

- **2026-02-20 20:00**: Dashboard package missing `files` field. **Fixed** — `"files": ["dist", "README.md"]` and `"prepublishOnly": "tsc"` added to package.json.

- **2026-02-20 20:00**: 20 stale `pending` entries in failed-tasks.md. All correspond to tasks completed via fresh implementations. Watchdog auto-supersede with fuzzy title normalization is implemented (uncommitted in working directory) and should clear these on next run.

- **2026-02-20 20:00**: Watchdog auto-supersede exact title matching couldn't catch variant titles. **Fixed** — `_normalize_title()` function added to strip tags, "FRESH implementation" suffix, lowercase, and compare first 50 chars. (Uncommitted in working directory, pending commit task.)

- **2026-02-20 20:00**: CLI `isProcessRunning`/`readFile` DRY extraction. **Fixed** — shared utilities created in `packages/cli/src/utils/`, all 7 CLI files updated to import.

- **2026-02-24**: Orphaned working directory changes from killed workers left uncommitted on `main`. **Fixed** — landed in atomic commits via "Land orphaned main hardening changes" (multiple passes, all merged to main).

- **2026-02-24**: Shell injection risk in `skynet config set` — `execSync` allowed arbitrary command execution via crafted config values. **Fixed** — shell-execution path removed entirely. See completed tasks: "Remove shell-execution path from skynet config set", "Patch shell injection risk in skynet config set".

- **2026-02-24**: Health score formula mismatch — watchdog, CLI `status`, and dashboard `pipeline-status` handler each used different health score math and hardcoded `SKYNET_STALE_MINUTES=45`. **Fixed** — unified stale-threshold and health-score parity across all three surfaces. See completed tasks: "Unify stale-threshold and health-score parity across CLI/dashboard/watchdog", "Align watchdog health score math with CLI/dashboard".

- **2026-02-24**: Stale heartbeat threshold hardcoded in multiple locations instead of reading `SKYNET_STALE_MINUTES` from config. **Fixed** — all consumer sites now read from config with fallback default. See completed task: "Make stale heartbeat threshold config-consistent everywhere".

- **2026-02-24**: 21 stale `pending` entries in `failed-tasks.md` for tasks already completed via fresh implementations. **Fixed** — all 21 entries superseded. Watchdog auto-supersede with fuzzy title normalization prevents recurrence. See completed tasks: "Supersede 21 stale pending entries in failed-tasks.md", "Improve watchdog auto-supersede to catch stale failed-tasks with title variations".


- **2026-02-25**: Three previously-active retry tasks resolved: (1) keyboard shortcuts merged in `7bf54be`, (2) velocity chart merged in `6f9f633`, (3) sparkline task superseded. No remaining active retries from 2026-02-24 batch.

- **2026-03-03**: Previous blockers entry incorrectly claimed LLM shell work had landed on main. **Resolved** — correction verified via `git merge-base --is-ancestor`, fresh backlog of 8 tasks was created and attempted. All attempts failed (see below), but the misattribution was corrected.

- **2026-03-03**: Key lessons from prior LLM failures captured: (1) types.ts changes must be additive optional fields, (2) don't touch barrel exports, (3) use cast pattern for backward-compatible JSON reads, (4) always pull main before committing. **Resolved** — lessons embedded in task descriptions for the 2026-03-03 batch.

- **2026-03-03**: All 11 LLM Provider Selection task attempts failed (9 from fresh 2026-03-03 batch + 2 earlier). Failure modes: 6 typecheck failures, 3 merge conflicts, 2 claude exit code errors. Pipeline moved on to self-correction infrastructure work. **Resolved** — failed tasks recorded in `failed-tasks.md`, dead branches preserved for potential future retry.


## Active

_(No active blockers as of 2026-03-03.)_

## Mission Status

**MISSION: LLM Provider Selection in Mission Admin** (started 2026-02-25). 0/5 goals, 0/6 success criteria met. **Stalled.**

**Completed work on main**: NONE. All LLM work remains on orphaned feature branches only.

**Backlog**: Empty. The 6 fresh LLM tasks from 2026-03-03 all failed and no replacements were generated. The project-driver has since shifted focus to self-correction infrastructure (watchdog reconciliation, telemetry snapshots, convergence counters).

**Failed attempts**: 11 total in `failed-tasks.md` — typecheck failures (types.ts export conflicts with concurrent merges) and merge conflicts (multiple workers touching shared files simultaneously).
