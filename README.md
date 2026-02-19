# Skynet

## What is Skynet

Skynet is an autonomous AI development pipeline that uses LLM agents (Claude Code, Codex) as coding workers, bash scripts as the orchestration engine, and markdown files as state. It claims tasks from a backlog, creates isolated git worktrees, invokes an AI agent to implement changes, runs quality gates (typecheck, lint, tests), merges on success, and self-corrects failures — building, testing, and shipping code around the clock with zero human intervention.

## Quickstart

```bash
npm install -g @ajioncorp/skynet-cli
skynet init
skynet setup-agents
skynet start
```

`skynet init` runs an interactive wizard that scaffolds a `.dev/` directory in your project with config files, state files, and worker scripts. `setup-agents` installs scheduled workers (macOS LaunchAgents or Linux cron). `start` kicks off the pipeline.

**Prerequisites:** macOS or Linux, Node.js 18+, Git, Claude Code CLI authenticated (`claude`).

## How It Works

The pipeline runs as a continuous loop:

1. **project-driver** reads `mission.md` and pipeline state, then generates and prioritizes tasks in `backlog.md`.
2. **watchdog** runs every 3 minutes — it detects idle workers, checks auth, cleans up stale locks and orphaned worktrees, and dispatches workers when there's work to do.
3. **dev-worker** (up to 2 in parallel) claims a task, creates an isolated git worktree, invokes the AI agent with project context, then runs numbered quality gates (`SKYNET_GATE_1`, `SKYNET_GATE_2`, ...) before merging to main.
4. **task-fixer** picks up failed tasks from `failed-tasks.md`, checks for merge conflicts (creating a fresh branch if needed), and retries with full error context — up to `SKYNET_MAX_FIX_ATTEMPTS` before marking as blocked.
5. **watchdog** detects the worker is idle again and dispatches the next task.

Supporting workers run on their own schedules: **health-check** (daily typecheck + lint with auto-fix), **ui-tester** (hourly Playwright smoke tests), **feature-validator** (deep tests every 2h), **sync-runner** (API sync every 6h), and **auth-refresh** (OAuth token refresh every 30m).

All state lives in `.dev/` as markdown: `backlog.md`, `completed.md`, `failed-tasks.md`, `blockers.md`, `mission.md`.

## CLI Reference

| Command | Description |
|---------|-------------|
| `skynet init` | Interactive wizard — scaffolds `.dev/` directory with config, state files, and worker scripts |
| `skynet setup-agents` | Installs macOS LaunchAgents or Linux crontab entries for all workers |
| `skynet start` | Loads LaunchAgents or spawns watchdog as a background process |
| `skynet stop` | Unloads agents and kills all running worker processes |
| `skynet status` | Shows task counts, worker states, health score (0–100), auth state, and blockers |
| `skynet doctor` | Diagnostics — checks required tools, config, scripts, agent availability, git state |
| `skynet logs [type]` | Lists log files, or tails a specific log (`worker`, `fixer`, `watchdog`, `health-check`) |
| `skynet version` | Shows CLI version and checks npm for updates |
| `skynet add-task <title>` | Adds a task to `backlog.md` with optional `--tag` and `--description` |
| `skynet reset-task <title>` | Resets a failed task back to pending (clears attempts, optionally deletes branch) |
| `skynet dashboard` | Launches the admin dashboard (Next.js app) and opens browser |
| `skynet cleanup` | Removes stale worktrees, lock files, and rotates logs |

## Dashboard

Skynet ships an admin UI as a React component library (`@ajioncorp/skynet`) plus a reference Next.js app (`packages/admin`). Launch it with:

```bash
skynet dashboard --port 3100
```

The dashboard provides real-time views into pipeline state:

| Component | Description |
|-----------|-------------|
| `PipelineDashboard` | Worker status, manual triggers, live logs, backlog overview |
| `MonitoringDashboard` | System health, agent status, task metrics |
| `TasksDashboard` | Backlog management with create-task form |
| `SyncDashboard` | Data sync endpoint health |
| `PromptsDashboard` | View worker prompt templates |
| `WorkerScaling` | Adjust worker concurrency |

API handlers follow a factory pattern — `createPipelineStatusHandler(config)` returns a Next.js route handler. Mount them in any Next.js app with `createConfig({ projectName, devDir, lockPrefix })`.

## Configuration

After `skynet init`, two config files live in `.dev/`:

**`skynet.config.sh`** — machine-specific, gitignored:

| Variable | Default | Description |
|----------|---------|-------------|
| `SKYNET_PROJECT_NAME` | — | Lowercase project identifier |
| `SKYNET_PROJECT_DIR` | — | Absolute path to project root |
| `SKYNET_DEV_SERVER_CMD` | `pnpm dev` | Command to start dev server |
| `SKYNET_GATE_1` / `_2` / `_3` | `pnpm typecheck` | Quality gates run before merge (sequential) |
| `SKYNET_MAX_WORKERS` | `2` | Parallel dev workers |
| `SKYNET_STALE_MINUTES` | `45` | Auto-kill stuck workers after N minutes |
| `SKYNET_MAX_FIX_ATTEMPTS` | `3` | Retries before task-fixer marks task as blocked |
| `SKYNET_AGENT_PLUGIN` | `auto` | Agent selection: `auto`, `claude`, `codex`, or path to custom plugin |
| `SKYNET_NOTIFY_CHANNELS` | `telegram` | Notification channels: `telegram`, `slack`, `discord` |

**`skynet.project.sh`** — project-specific, committable:

| Variable | Description |
|----------|-------------|
| `SKYNET_WORKER_CONTEXT` | Project conventions injected into every agent prompt |
| `SKYNET_PROJECT_VISION` | Fallback mission if `mission.md` doesn't exist |
| `SKYNET_SYNC_ENDPOINTS` | API endpoints for sync-runner (`"name\|path"` format) |
| `SKYNET_TASK_TAGS` | Allowed tags: `FEAT FIX INFRA TEST NMI` |

## Architecture

```
skynet/
├── packages/cli/          @ajioncorp/skynet-cli
│   └── src/commands/      One file per CLI command (init, start, status, ...)
├── packages/dashboard/    @ajioncorp/skynet
│   ├── src/components/    React components (PipelineDashboard, TasksDashboard, ...)
│   ├── src/handlers/      Factory-pattern API handlers (createXxxHandler)
│   └── src/lib/           Config loader, backlog parser, worker status
├── packages/admin/        Reference Next.js 15 admin app
│   └── src/app/           App Router pages + API routes mounting dashboard handlers
├── scripts/               Bash pipeline engine
│   ├── _config.sh         Universal config loader
│   ├── _agent.sh          AI agent abstraction (run_agent; supports claude/codex/plugins)
│   ├── _notify.sh         Multi-channel notifications (telegram, slack, discord)
│   ├── _compat.sh         Cross-platform bash 3.2 compatibility
│   ├── watchdog.sh        Dispatcher + crash recovery + stale lock cleanup
│   ├── dev-worker.sh      Main coding worker (worktree → agent → gates → merge)
│   ├── task-fixer.sh      Failed task retry with merge-conflict detection
│   ├── project-driver.sh  Mission-driven task generator
│   └── ...                health-check, ui-tester, feature-validator, sync-runner, auth-refresh
└── templates/             Scaffolded into consumer projects by `skynet init`
    ├── launchagents/      macOS LaunchAgent plist templates
    ├── skynet.config.sh   Config template
    └── *.md               State file templates (backlog, mission, completed, ...)
```

Workers use `mkdir`-based mutex locks (atomic on all Unix) and PID lock files in `/tmp/skynet-{project}-*.lock`. State is plain markdown in `.dev/`. Git worktrees provide full isolation so parallel workers never conflict.

## License

MIT
