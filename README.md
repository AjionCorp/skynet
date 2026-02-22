# Skynet

Skynet is an autonomous AI development pipeline. It uses LLM agents (Claude Code, OpenAI Codex) as coding workers, bash scripts as the orchestration engine, and markdown files as state. It claims tasks from a backlog, creates isolated git worktrees, invokes an AI agent to implement changes, runs quality gates (typecheck, lint, tests), merges on success, and self-corrects failures — building, testing, and shipping code around the clock with zero human intervention.

## Table of Contents

- [Quickstart](#quickstart)
- [How It Works](#how-it-works)
- [Setup Guide](#setup-guide)
  - [Prerequisites](#prerequisites)
  - [Install the CLI](#install-the-cli)
  - [Initialize a Project](#initialize-a-project)
  - [Write Your Mission](#write-your-mission)
  - [Configure Quality Gates](#configure-quality-gates)
  - [Set Up Notifications](#set-up-notifications)
  - [Install Workers](#install-workers)
  - [Start the Pipeline](#start-the-pipeline)
- [Usage Examples](#usage-examples)
- [CLI Reference](#cli-reference)
- [Configuration Reference](#configuration-reference)
- [Dashboard](#dashboard)
- [Writing a Good Mission](#writing-a-good-mission)
- [Worker Context and Conventions](#worker-context-and-conventions)
- [Skills](#skills)
- [Agent Plugins](#agent-plugins)
- [State Files](#state-files)
- [Architecture](#architecture)
- [Troubleshooting](#troubleshooting)
- [License](#license)

## Quickstart

```bash
npm install -g @ajioncorp/skynet-cli
cd your-project
skynet init
skynet setup-agents
skynet start
```

That's it. The pipeline reads your `.dev/mission.md`, generates tasks, and starts implementing them autonomously.

## How It Works

The pipeline runs as a continuous loop with five core workers:

```
                    ┌─────────────────┐
                    │   mission.md    │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │ project-driver  │──── Reads mission + state,
                    │                 │     generates prioritized tasks
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │   backlog.md    │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │    watchdog     │──── Every 3 min: dispatch workers,
                    │                 │     crash recovery, health checks
                    └────────┬────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
     ┌────────▼───────┐     ...    ┌───────▼────────┐
     │  dev-worker 1  │            │  dev-worker 4  │
     │                │            │                │
     │ 1. claim task  │            │  (up to 4 in   │
     │ 2. worktree    │            │   parallel)    │
     │ 3. AI agent    │            │                │
     │ 4. gates       │            │                │
     │ 5. merge       │            │                │
     │ 6. smoke test  │            │  auto-reverts  │
     │    (optional)  │            │  on failure    │
     └────────┬───────┘            └───────┬────────┘
              │  on failure                │
     ┌────────▼────────┐                   │
     │  failed-tasks   │                   │
     └────────┬────────┘                   │
              │                            │
     ┌────────▼────────┐          ┌────────▼────────┐
     │   task-fixer    │          │  completed.md   │
     │ retry w/ error  │          │                 │
     │ context, up to  │          └─────────────────┘
     │ 3 attempts      │
     └─────────────────┘
```

1. **project-driver** reads `mission.md` and all pipeline state, then generates and prioritizes tasks in `backlog.md`.
2. **watchdog** runs every 3 minutes — dispatches idle workers, recovers from crashes, cleans stale locks and orphaned worktrees, monitors health.
3. **dev-worker** (up to 4 in parallel) claims a task, creates an isolated git worktree, invokes the AI agent with project context, runs quality gates, and merges to main.
4. **task-fixer** picks up failed tasks, retries with full error context (logs, diffs), and handles merge conflicts automatically — up to `SKYNET_MAX_FIX_ATTEMPTS` before marking as blocked.
5. The loop repeats. When the backlog runs low, project-driver generates the next batch.

Supporting workers run on their own schedules: **health-check** (daily typecheck + lint with auto-fix), **ui-tester** (hourly Playwright smoke tests), **sync-runner** (API sync every 6h), and **auth-refresh** (OAuth token refresh every 30m).

## Setup Guide

### Prerequisites

| Requirement | Version | Check |
|-------------|---------|-------|
| macOS or Linux | — | `uname` |
| Node.js | 18+ (20+ recommended) | `node -v` |
| Git | Any recent | `git --version` |
| pnpm | 9+ | `pnpm -v` |
| Claude Code CLI | Authenticated | `claude --version` |

Claude Code is the default AI agent. Install it and authenticate:

```bash
npm install -g @anthropic-ai/claude-code
claude
# Follow the login prompts
```

Optionally, install OpenAI Codex CLI as a fallback agent:

```bash
npm install -g @openai/codex
```

### Install the CLI

```bash
npm install -g @ajioncorp/skynet-cli
```

Verify the installation:

```bash
skynet version
```

### Initialize a Project

Navigate to your project's git repo and run the interactive wizard:

```bash
cd ~/projects/my-app
skynet init
```

The wizard asks for:
- **Project name** — a lowercase identifier (e.g. `my-app`), used in lock files and worktree paths
- **Project directory** — defaults to the current directory
- **Dev server command** — e.g. `pnpm dev`, `npm run dev`, `yarn dev`
- **Typecheck command** — e.g. `pnpm typecheck`, `npx tsc --noEmit`
- **Package install command** — e.g. `pnpm install --frozen-lockfile`, `npm ci`

This creates a `.dev/` directory with:

```
.dev/
├── skynet.config.sh      # Machine-specific config (gitignored)
├── skynet.project.sh     # Project-specific config (commit this)
├── mission.md            # Your project's mission (commit this)
├── backlog.md            # Task queue
├── completed.md          # Completed task log
├── failed-tasks.md       # Failed task log
├── blockers.md           # Active blockers
├── current-task.md       # Current worker status
└── scripts/              # Worker scripts (symlinked)
```

You can also run non-interactively:

```bash
skynet init --name my-app --dir /path/to/my-app --non-interactive
```

### Write Your Mission

Edit `.dev/mission.md` to define what the pipeline should build. This is the most important file — it drives the project-driver's task generation:

```markdown
# Mission

## Purpose

A task management API with real-time updates and role-based access control.

## Goals

1. REST API for CRUD operations on tasks, projects, and users
2. WebSocket support for real-time task updates
3. Role-based access control (admin, manager, member)
4. PostgreSQL with Prisma ORM
5. 90%+ test coverage on business logic

## Success Criteria

The mission is complete when:
1. All CRUD endpoints pass integration tests
2. WebSocket broadcasts are verified with automated tests
3. RBAC middleware blocks unauthorized access in all tested scenarios
4. Database migrations run cleanly on a fresh database
5. CI pipeline passes with no warnings

## Current Focus

Start with the database schema and basic CRUD endpoints. Authentication
can use simple JWT for now — we'll add OAuth later.
```

### Configure Quality Gates

Quality gates run in order before any branch is merged. Edit `.dev/skynet.config.sh`:

```bash
# Gate 1 is required. Defaults to pnpm typecheck if not set.
export SKYNET_GATE_1="pnpm typecheck"

# Add more gates as needed:
export SKYNET_GATE_2="pnpm lint"
export SKYNET_GATE_3="pnpm test --run"
# export SKYNET_GATE_4="npx playwright test e2e/smoke.spec.ts"
```

If any gate exits non-zero, the branch is **not** merged and the task moves to `failed-tasks.md` for retry.

### Enable Post-Merge Smoke Tests

Smoke tests validate that merged code doesn't break API routes at runtime:

```bash
skynet config set SKYNET_POST_MERGE_SMOKE true
```

After each merge, the smoke test hits all dashboard API endpoints, verifying HTTP 200 responses and valid `{ data, error }` JSON shape. If any endpoint fails, the merge is **automatically reverted** and the task moves to `failed-tasks.md` for retry.

The watchdog also runs periodic smoke checks. If main fails 2 consecutive checks, the pipeline is auto-paused until the issue is resolved.

**Requirements:** The Next.js dev server must be running (`skynet dashboard` or `pnpm dev:admin`). If the server is not reachable, smoke tests are skipped gracefully.

### Set Up Notifications

Get notified when tasks complete, fail, or when the pipeline needs attention.

**Telegram:**

```bash
skynet config set SKYNET_TG_ENABLED true
skynet config set SKYNET_TG_BOT_TOKEN "your-bot-token"
skynet config set SKYNET_TG_CHAT_ID "your-chat-id"
skynet config set SKYNET_NOTIFY_CHANNELS "telegram"
```

**Slack:**

```bash
skynet config set SKYNET_SLACK_WEBHOOK_URL "https://hooks.slack.com/services/..."
skynet config set SKYNET_NOTIFY_CHANNELS "slack"
```

**Discord:**

```bash
skynet config set SKYNET_DISCORD_WEBHOOK_URL "https://discord.com/api/webhooks/..."
skynet config set SKYNET_NOTIFY_CHANNELS "discord"
```

**Multiple channels:**

```bash
skynet config set SKYNET_NOTIFY_CHANNELS "telegram,slack,discord"
```

Test your configuration:

```bash
skynet test-notify
skynet test-notify --channel telegram
```

### Install Workers

This installs scheduled workers as macOS LaunchAgents or Linux cron jobs:

```bash
skynet setup-agents
```

On macOS, this creates plist files in `~/Library/LaunchAgents/` for each worker type. On Linux, it adds crontab entries.

Preview what would be installed without actually doing it:

```bash
skynet setup-agents --dry-run
```

To remove all installed workers:

```bash
skynet setup-agents --uninstall
```

### Start the Pipeline

```bash
skynet start
```

This loads the LaunchAgents (macOS) or starts the watchdog as a background process (Linux). The watchdog then dispatches workers as needed.

Check that everything is running:

```bash
skynet status
```

You should see workers as idle (or active if tasks exist), auth status as OK, and a health score.

## Usage Examples

### Add tasks manually

```bash
# Simple task
skynet add-task "Add user authentication" --tag FEAT

# With description
skynet add-task "Fix login redirect loop" --tag FIX \
  --description "After login, users are redirected back to /login instead of /dashboard"

# Add at a specific position (1 = top priority)
skynet add-task "Critical security patch" --tag FIX --position 1
```

### Manage skills

```bash
# Create a new skill
skynet add-skill api-design --tags "FEAT" --description "REST API design conventions"

# Create a universal skill (injected for all tasks)
skynet add-skill code-review

# List all skills and their tag bindings
skynet list-skills
```

### Run a one-shot task (no backlog)

```bash
skynet run "Add input validation to the user registration endpoint"
skynet run "Refactor the database connection to use connection pooling" --gate "pnpm typecheck"
```

### Check pipeline status

```bash
# Human-readable summary
skynet status

# Machine-readable JSON
skynet status --json

# Quiet mode — just the health score (useful for scripts)
skynet status --quiet
```

### Monitor in real-time

```bash
# Terminal dashboard with live refresh
skynet watch

# Or launch the web dashboard
skynet dashboard
```

### View logs

```bash
# List all available logs
skynet logs

# Tail a specific worker's log
skynet logs worker --id 1 --follow
skynet logs fixer --tail 50
skynet logs watchdog --tail 100
```

### Manage failures

```bash
# See what failed and why
skynet status

# Reset a blocked task back to pending for another attempt
skynet reset-task "Add user authentication"

# Force reset (also deletes the branch for a clean start)
skynet reset-task "Add user authentication" --force
```

### Pause and resume

```bash
# Pause — workers finish their current task then stop
skynet pause

# Resume — workers restart on next watchdog cycle
skynet resume
```

### Pipeline maintenance

```bash
# Run diagnostics
skynet doctor

# Auto-fix common issues
skynet doctor --fix

# Clean up stale worktrees, lock files, old logs
skynet cleanup

# Pre-flight validation
skynet validate
```

### Configuration

```bash
# List all config variables and their values
skynet config list

# Get a specific value
skynet config get SKYNET_MAX_WORKERS

# Set a value (with validation)
skynet config set SKYNET_MAX_WORKERS 2

# Migrate config after upgrading Skynet (adds new variables)
skynet config migrate
```

### Export and import state

```bash
# Snapshot current state
skynet export --output backup.json

# Restore from snapshot
skynet import backup.json

# Dry-run import (see what would change)
skynet import backup.json --dry-run

# Merge with existing state instead of replacing
skynet import backup.json --merge
```

### Generate a changelog

```bash
# From completed tasks
skynet changelog

# Since a specific date
skynet changelog --since 2026-01-01

# Save to file
skynet changelog --output CHANGELOG.md
```

### Shell completions

```bash
# Bash
skynet completions bash >> ~/.bashrc

# Zsh
skynet completions zsh >> ~/.zshrc
```

## CLI Reference

| Command | Description |
|---------|-------------|
| `skynet init` | Interactive wizard — scaffolds `.dev/` directory with config, state files, and worker scripts |
| `skynet setup-agents` | Installs macOS LaunchAgents or Linux crontab entries for all workers |
| `skynet start` | Loads LaunchAgents or spawns watchdog as a background process |
| `skynet stop` | Unloads agents and kills all running worker processes |
| `skynet pause` | Pauses the pipeline — workers exit gracefully at their next checkpoint |
| `skynet resume` | Resumes a paused pipeline |
| `skynet status` | Shows task counts, worker states, health score, auth state, and blockers |
| `skynet doctor` | Diagnostics — checks tools, config, scripts, agent availability, git state |
| `skynet validate` | Run pre-flight project validation checks |
| `skynet logs [type]` | View/tail worker logs (`worker`, `fixer`, `watchdog`, `health-check`) |
| `skynet add-task <title>` | Adds a task to `backlog.md` with optional `--tag` and `--description` |
| `skynet add-skill <name>` | Creates a new skill file in `.dev/skills/` with optional `--tags` and `--description` |
| `skynet list-skills` | Lists all skill files and their tag bindings |
| `skynet reset-task <title>` | Resets a failed task back to pending (clears attempts, optionally deletes branch) |
| `skynet run <prompt>` | Execute a one-shot task without adding to backlog |
| `skynet dashboard` | Launches the admin dashboard (Next.js app) and opens browser |
| `skynet watch` | Real-time terminal dashboard with 3s refresh |
| `skynet cleanup` | Removes stale worktrees, lock files, and rotates logs |
| `skynet upgrade` | Check for and install latest CLI version |
| `skynet version` | Shows CLI version and checks for updates |
| `skynet metrics` | Display pipeline performance analytics |
| `skynet config <sub>` | Manage config — `list`, `get KEY`, `set KEY VALUE`, `migrate` |
| `skynet export` | Export pipeline state as a JSON snapshot |
| `skynet import <file>` | Restore pipeline state from an exported snapshot |
| `skynet changelog` | Generate changelog from completed tasks |
| `skynet test-notify` | Test notification channel configuration |
| `skynet completions <shell>` | Generate bash or zsh shell completions |

## Configuration Reference

After `skynet init`, two config files live in `.dev/`:

### `skynet.config.sh` — Machine-specific (gitignored)

Contains local paths, ports, secrets, and tuning knobs. Not committed to git.

**Project identity:**

| Variable | Default | Description |
|----------|---------|-------------|
| `SKYNET_PROJECT_NAME` | *(required)* | Unique lowercase project identifier |
| `SKYNET_PROJECT_DIR` | *(required)* | Absolute path to project root |
| `SKYNET_DEV_DIR` | `$PROJECT_DIR/.dev` | Pipeline state directory |

**Dev server:**

| Variable | Default | Description |
|----------|---------|-------------|
| `SKYNET_DEV_SERVER_CMD` | `pnpm dev` | Command to start dev server |
| `SKYNET_DEV_SERVER_URL` | `http://localhost:3000` | Dev server URL for health checks |
| `SKYNET_DEV_PORT` | `3000` | Base port (workers offset from this) |

**Build and quality gates:**

| Variable | Default | Description |
|----------|---------|-------------|
| `SKYNET_TYPECHECK_CMD` | `pnpm typecheck` | Typecheck command (also Gate 1 fallback) |
| `SKYNET_LINT_CMD` | `pnpm lint` | Lint command (not a gate by default) |
| `SKYNET_INSTALL_CMD` | `pnpm install --frozen-lockfile` | Package install command in worktrees |
| `SKYNET_GATE_1` | `pnpm typecheck` | Quality gate 1 (required, runs before merge) |
| `SKYNET_GATE_2` | *(disabled)* | Quality gate 2 (optional) |
| `SKYNET_GATE_3` | *(disabled)* | Quality gate 3 (optional) |
| `SKYNET_POST_MERGE_SMOKE` | `false` | Enable post-merge smoke tests and auto-revert |
| `SKYNET_SMOKE_TIMEOUT` | `10` | Per-endpoint timeout in seconds for smoke tests |

**Git:**

| Variable | Default | Description |
|----------|---------|-------------|
| `SKYNET_BRANCH_PREFIX` | `dev/` | Feature branch prefix |
| `SKYNET_MAIN_BRANCH` | `main` | Main branch for merges |

**Worker tuning:**

| Variable | Default | Description |
|----------|---------|-------------|
| `SKYNET_MAX_WORKERS` | `4` | Max concurrent dev-worker instances |
| `SKYNET_MAX_FIXERS` | `3` | Max concurrent task-fixer instances |
| `SKYNET_MAX_TASKS_PER_RUN` | `5` | Tasks per worker run before exit |
| `SKYNET_STALE_MINUTES` | `45` | Heartbeat stale threshold (auto-kill) |
| `SKYNET_AGENT_TIMEOUT_MINUTES` | `45` | Kill agent after N minutes (0 = no limit) |
| `SKYNET_MAX_FIX_ATTEMPTS` | `3` | Retries before marking task as blocked |
| `SKYNET_DRIVER_BACKLOG_THRESHOLD` | `5` | Trigger project-driver below this count |
| `SKYNET_WATCHDOG_INTERVAL` | `180` | Seconds between watchdog cycles |
| `SKYNET_HEALTH_ALERT_THRESHOLD` | `50` | Alert when health score drops below this |

**Agent selection:**

| Variable | Default | Description |
|----------|---------|-------------|
| `SKYNET_AGENT_PLUGIN` | `auto` | `auto`, `claude`, `codex`, or path to custom plugin |
| `SKYNET_CLAUDE_BIN` | `claude` | Path to Claude Code binary |
| `SKYNET_CLAUDE_FLAGS` | `--print --dangerously-skip-permissions` | Claude CLI flags |
| `SKYNET_CODEX_BIN` | `codex` | Path to Codex binary |
| `SKYNET_CODEX_FLAGS` | `--full-auto` | Codex CLI flags |

**Skills:**

| Variable | Default | Description |
|----------|---------|-------------|
| `SKYNET_SKILLS_DIR` | `$DEV_DIR/skills` | Directory containing skill markdown files |

**Notifications:**

| Variable | Default | Description |
|----------|---------|-------------|
| `SKYNET_NOTIFY_CHANNELS` | `telegram` | Comma-separated: `telegram`, `slack`, `discord` |
| `SKYNET_TG_ENABLED` | `false` | Enable Telegram notifications |
| `SKYNET_TG_BOT_TOKEN` | *(empty)* | Telegram bot token from @BotFather |
| `SKYNET_TG_CHAT_ID` | *(empty)* | Telegram chat/group ID |
| `SKYNET_SLACK_WEBHOOK_URL` | *(empty)* | Slack incoming webhook URL |
| `SKYNET_DISCORD_WEBHOOK_URL` | *(empty)* | Discord webhook URL |

### `skynet.project.sh` — Project-specific (committed)

Contains project conventions and context injected into agent prompts. Safe to commit.

| Variable | Description |
|----------|-------------|
| `SKYNET_WORKER_CONTEXT` | Multi-line string appended to every agent prompt — project conventions, debugging tips, available APIs |
| `SKYNET_PROJECT_VISION` | Fallback mission if `mission.md` doesn't exist |
| `SKYNET_SYNC_ENDPOINTS` | Array of `"name\|path"` entries for the sync-runner |
| `SKYNET_SYNC_STATIC` | Static sync entries (no API call) |
| `SKYNET_TASK_TAGS` | Allowed tags: `FEAT FIX INFRA TEST NMI` |

## Dashboard

Skynet ships a web-based admin dashboard as a React component library (`@ajioncorp/skynet`) plus a reference Next.js app.

```bash
skynet dashboard            # Opens on port 3100
skynet dashboard --port 8080  # Custom port
```

Dashboard pages:

| Page | URL | Description |
|------|-----|-------------|
| Pipeline | `/admin/pipeline` | Worker status, manual triggers, live logs |
| Monitoring | `/admin/monitoring` | System health, agent status, metrics |
| Tasks | `/admin/tasks` | Backlog management, create tasks |
| Mission | `/admin/mission` | Mission progress, goal completion |
| Events | `/admin/events` | Full event history with search and filtering |
| Logs | `/admin/logs` | Tail worker and system logs |
| Settings | `/admin/settings` | View/edit `skynet.config.sh` |
| Workers | `/admin/workers` | Adjust worker concurrency |
| Sync | `/admin/sync` | Data sync endpoint health |
| Prompts | `/admin/prompts` | View worker prompt templates |

### Embedding in your own Next.js app

The dashboard components are published as `@ajioncorp/skynet`. Mount the API handlers and use the React components in any Next.js 15 app:

```typescript
// app/api/admin/pipeline/status/route.ts
import { createPipelineStatusHandler, createConfig } from "@ajioncorp/skynet/handlers";

const config = createConfig({
  projectName: "my-app",
  devDir: "/path/to/my-app/.dev",
  lockPrefix: "/tmp/skynet-my-app",
});

const { GET } = createPipelineStatusHandler(config);
export { GET };
```

```tsx
// app/admin/page.tsx
import { SkynetProvider, PipelineDashboard } from "@ajioncorp/skynet";

export default function AdminPage() {
  return (
    <SkynetProvider apiPrefix="/api/admin">
      <PipelineDashboard />
    </SkynetProvider>
  );
}
```

## Writing a Good Mission

The mission file (`.dev/mission.md`) is the most important input to the pipeline. The project-driver reads it on every cycle to decide what tasks to generate. A good mission leads to focused, high-quality task generation.

### Tips

- **Be specific and measurable.** "Add user auth" is vague. "JWT-based authentication with email/password login, registration, and password reset" gives the agent enough to generate concrete tasks.
- **Prioritize with "Current Focus."** The project-driver generates tasks for whatever's in Current Focus first. Update this section as priorities shift.
- **Define success criteria.** Without clear criteria, the project-driver can't know when the mission is done. It checks these on every cycle and celebrates when all are met.
- **Update as you go.** Move completed goals out of Current Focus. Add new focus areas. The mission is a living document.

### Example: E-commerce API

```markdown
# Mission

## Purpose

A headless e-commerce API for a furniture marketplace. Next.js storefront
consumes it. Must handle catalog, cart, checkout, and order management.

## Goals

1. Product catalog API with categories, search, and filtering
2. Shopping cart with guest and authenticated user support
3. Stripe checkout integration with webhook handling
4. Order management with status tracking and email notifications
5. Admin API for inventory management

## Success Criteria

The mission is complete when:
1. All catalog, cart, and order endpoints pass integration tests
2. Stripe test-mode checkout completes end-to-end
3. Webhook handler processes payment_intent.succeeded events
4. Email notifications fire on order status changes
5. Admin endpoints are protected by role middleware

## Current Focus

Build the product catalog first — schema, seed data, CRUD endpoints,
and search with Prisma full-text search. Cart can come after.
```

### Example: CLI Tool

```markdown
# Mission

## Purpose

A CLI tool for managing Kubernetes deployments with pre-flight checks,
rollback support, and Slack notifications.

## Goals

1. Deploy command: reads manifest, validates, applies with kubectl
2. Pre-flight checks: image exists, secrets present, resource limits set
3. Rollback command: revert to previous revision with confirmation
4. Status command: show deployment health, pod status, recent events
5. Slack notifications on deploy success/failure

## Success Criteria

1. Deploy command handles a 3-service manifest end-to-end
2. Pre-flight catches missing image tags and absent secrets
3. Rollback reverts cleanly and reports success
4. All commands have --help text and man pages
5. Unit tests cover argument parsing and validation logic

## Current Focus

Start with the deploy command and pre-flight checks. Status command
is the next priority. Rollback and notifications are lower priority.
```

## Worker Context and Conventions

The `SKYNET_WORKER_CONTEXT` variable in `.dev/skynet.project.sh` is injected into every agent prompt. Use it to teach the AI agent your project's patterns and conventions.

### Example: Next.js project

```bash
SKYNET_WORKER_CONTEXT="
# Project Conventions
- Next.js 15 App Router with TypeScript strict mode
- Use server components by default, 'use client' only when needed
- Tailwind CSS for styling — no CSS modules or styled-components
- Prisma ORM for database access — schema at prisma/schema.prisma
- API routes return { data, error } shape — see lib/api-response.ts

# File Structure
- app/             App Router pages and API routes
- components/      Shared React components
- lib/             Utilities, database client, auth helpers
- prisma/          Schema and migrations

# Testing
- Vitest for unit tests — colocated as *.test.ts next to source
- Playwright for e2e — in tests/e2e/

# Debugging
- Dev server runs on port 3000: pnpm dev
- Database studio: pnpm prisma studio
- Check for type errors: pnpm typecheck
"
```

### Example: Python project

```bash
SKYNET_WORKER_CONTEXT="
# Project Conventions
- Python 3.12 with type hints everywhere
- FastAPI for the web framework
- SQLAlchemy 2.0 with async sessions
- Alembic for migrations
- pytest for testing

# Commands
- Dev server: uvicorn app.main:app --reload
- Tests: pytest -x
- Type check: mypy app/
- Lint: ruff check app/

# Patterns
- Dependency injection via FastAPI Depends()
- Pydantic v2 models for request/response schemas
- Repository pattern for database access
"
```

## Skills

Skills are reusable instruction sets that get injected into worker prompts. They live as markdown files in `.dev/skills/` and are automatically loaded by the pipeline based on task tags.

### How it works

When a dev-worker or task-fixer picks up a task like `[FEAT] Add user auth`, the pipeline:
1. Extracts the tag (`FEAT`)
2. Scans `.dev/skills/*.md` for skills matching that tag
3. Injects the matching skill content into the agent prompt

Skills with no tags are **universal** — they load for every task. Skills with tags only load when the task tag matches.

### Skill file format

```markdown
---
name: api-design
description: REST API design conventions
tags: FEAT,FIX
---

## API Design

- Use RESTful naming: plural nouns for collections, singular for resources
- Return { data, error } shape from all endpoints
- Use proper HTTP status codes (201 for created, 404 for not found)
- Validate request bodies at the handler level
```

The YAML frontmatter fields:
- `name` — skill identifier (matches filename)
- `description` — one-line summary
- `tags` — comma-separated uppercase tags. Empty = universal skill.

### CLI commands

```bash
# Create a skill for specific task types
skynet add-skill api-design --tags "FEAT,FIX" --description "REST API conventions"

# Create a universal skill (loads for all tasks)
skynet add-skill code-quality --description "General code standards"

# List all skills
skynet list-skills
```

### Template skills

`skynet init` scaffolds three starter skills:

| Skill | Tags | Description |
|-------|------|-------------|
| `code-quality` | *(all)* | General code quality standards |
| `testing` | `TEST,FIX` | Testing conventions |
| `infrastructure` | `INFRA` | Shell and infrastructure conventions |

Edit these to match your project, or delete the ones you don't need.

### Agent compatibility

Skills work identically across all agents (Claude Code, Codex, custom plugins) because they're injected directly into the prompt — not through any agent-specific mechanism. The same skills produce the same behavior regardless of which agent runs the task.

## Agent Plugins

Skynet supports multiple AI agents through a plugin system.

### Built-in agents

| Plugin | Config value | Description |
|--------|-------------|-------------|
| `auto` | `SKYNET_AGENT_PLUGIN=auto` | Tries Claude Code first, falls back to Codex if unavailable |
| `claude` | `SKYNET_AGENT_PLUGIN=claude` | Claude Code only (fails if auth expired) |
| `codex` | `SKYNET_AGENT_PLUGIN=codex` | OpenAI Codex CLI only |
| `echo` | `SKYNET_AGENT_PLUGIN=echo` | Dry-run mode — no LLM calls, creates placeholder commits |

### Writing a custom plugin

Create a bash script with two functions — `agent_check` (is it available?) and `agent_run` (execute a prompt):

```bash
#!/usr/bin/env bash
# scripts/agents/my-agent.sh

agent_check() {
  # Return 0 if the agent is available, 1 if not
  command -v my-ai-tool &>/dev/null
}

agent_run() {
  local prompt="$1"
  local log_file="${2:-/dev/null}"

  # Pipe the prompt to your tool and capture output
  echo "$prompt" | my-ai-tool --auto >> "$log_file" 2>&1
}
```

Activate it:

```bash
skynet config set SKYNET_AGENT_PLUGIN "/absolute/path/to/my-agent.sh"
```

The `echo` plugin is useful for testing the full pipeline lifecycle without burning LLM tokens.

## State Files

All pipeline state lives in `.dev/` as plain markdown. These files are managed exclusively by bash scripts — never edit them from TypeScript.

| File | Committed | Purpose |
|------|-----------|---------|
| `skynet.config.sh` | No (gitignored) | Machine-specific paths, ports, secrets |
| `skynet.project.sh` | Yes | Project context, worker conventions |
| `mission.md` | Yes | Mission definition driving task generation |
| `backlog.md` | Yes | Prioritized task queue |
| `completed.md` | Yes | Completed task log with dates and durations |
| `failed-tasks.md` | Yes | Failed task log with error details and retry status |
| `blockers.md` | Yes | Active and resolved blockers |
| `current-task-N.md` | Yes | Per-worker current task status |
| `events.log` | No (gitignored) | Structured event log |
| `sync-health.md` | Yes | Data sync endpoint health |
| `scripts/post-merge-smoke.log` | No (gitignored) | Smoke test results |

### Backlog format

```markdown
- [>] [FEAT] Claimed task being worked on
- [ ] [FIX] Pending task -- description of the bug
- [ ] [FEAT] Blocked task | blockedBy: Fix the dependency first
- [x] [FEAT] Completed task
```

Markers: `[ ]` pending, `[>]` claimed by worker, `[x]` done.
Tags: `[FEAT]`, `[FIX]`, `[INFRA]`, `[TEST]`, `[DATA]`, `[DOCS]`, `[NMI]`.
Dependencies: `| blockedBy: Task A, Task B` — worker skips these until dependencies are done.

### Failed tasks format

```markdown
| Date | Task | Branch | Error | Attempts | Status |
|------|------|--------|-------|----------|--------|
| 2026-02-19 | Task name | dev/branch | typecheck failed | 2 | pending |
| 2026-02-19 | Task name | merged to main | - | 1 | fixed |
| 2026-02-19 | Task name | dev/branch | error | 3 | blocked |
```

Status values: `pending` (awaiting retry), `fixing-N` (claimed by fixer N), `fixed` (merged), `blocked` (max attempts reached), `superseded` (duplicate/obsolete).

## Architecture

```
skynet/
├── packages/cli/          @ajioncorp/skynet-cli
│   └── src/commands/      One file per CLI command (init, start, status, ...)
├── packages/dashboard/    @ajioncorp/skynet (shared library)
│   ├── src/components/    React components (PipelineDashboard, TasksDashboard, ...)
│   ├── src/handlers/      Factory-pattern API handlers (createXxxHandler)
│   └── src/lib/           Config loader, backlog parser, worker status
├── packages/admin/        Reference Next.js 15 admin app
│   └── src/app/           App Router pages + API routes
├── scripts/               Bash pipeline engine
│   ├── _config.sh         Universal config loader
│   ├── _agent.sh          AI agent abstraction (plugin system)
│   ├── _notify.sh         Multi-channel notification dispatcher
│   ├── _compat.sh         Cross-platform bash 3.2 compatibility
│   ├── _events.sh         Structured event logging
│   ├── watchdog.sh        Dispatcher + crash recovery
│   ├── dev-worker.sh      Coding worker (worktree -> agent -> gates -> merge)
│   ├── task-fixer.sh      Failed task retry with error context
│   ├── project-driver.sh  Mission-driven task generator
│   ├── post-merge-smoke.sh Post-merge API smoke test + auto-revert trigger
│   ├── agents/            Agent plugins (claude, codex, echo)
│   └── notify/            Notification plugins (telegram, slack, discord)
└── templates/             Scaffolded by `skynet init`
```

### Concurrency model

- Workers use `mkdir`-based mutex locks (atomic on all Unix) for shared state access
- PID lock files in `/tmp/skynet-{project}-*.lock` prevent duplicate worker instances
- Git worktrees provide full filesystem isolation so parallel workers never conflict
- Heartbeat files detect stuck workers — watchdog auto-kills after `SKYNET_STALE_MINUTES`
- Graceful shutdown via SIGTERM/SIGINT — workers finish their current checkpoint before exiting

### Developing Skynet itself

```bash
git clone https://github.com/AjionCorp/skynet.git
cd skynet
pnpm install
pnpm typecheck        # Verify compilation
pnpm dev:admin        # Admin dashboard on port 3100
pnpm test             # Run all tests
pnpm lint:sh          # ShellCheck on all bash scripts
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for details on creating custom agent plugins, notification channels, and dashboard components.

## Troubleshooting

### Workers stuck or stale

Run `skynet doctor` to diagnose. Check worker heartbeats with `skynet status`. If workers appear stuck, restart:

```bash
skynet stop && skynet start
```

The watchdog auto-kills workers exceeding the stale threshold, but a manual restart also clears lock files and orphaned worktrees.

### Task keeps failing

Check fixer logs: `skynet logs fixer`. The task-fixer retries with full error context up to `SKYNET_MAX_FIX_ATTEMPTS` (default 3) before marking as blocked. To manually reset:

```bash
skynet reset-task "task name"         # Reset attempts, keep branch
skynet reset-task "task name" --force  # Reset attempts, delete branch
```

### Merge conflicts

The task-fixer auto-detects merge conflicts. When found, it deletes the stale branch and creates a fresh one from current `main`. No manual intervention needed.

### Dashboard not loading

```bash
skynet dashboard --port 3101  # Try a different port
node -v                        # Verify Node.js 18+
```

### Auth expired

Re-authenticate the Claude Code CLI:

```bash
claude
# Follow the login prompts
```

The `auth-refresh` worker syncs credentials automatically every 30 minutes. After re-authenticating, the next cycle picks up the new token.

### Backlog empty but mission not complete

This is expected. The watchdog triggers `project-driver` when fewer than 5 tasks remain. Check that `mission.md` has remaining goals and that the driver isn't blocked:

```bash
skynet logs watchdog --tail 50
```

### Pipeline seems slow

Reduce worker count if you're hitting API rate limits:

```bash
skynet config set SKYNET_MAX_WORKERS 2
skynet config set SKYNET_MAX_FIXERS 1
```

Check pipeline analytics:

```bash
skynet metrics
```

### Merge keeps getting reverted

If smoke tests are enabled (`SKYNET_POST_MERGE_SMOKE=true`), merges that break API routes are automatically reverted. Check the smoke test log:

```bash
skynet logs post-merge-smoke --tail 50
```

Common causes:
- Missing environment variables (check `.env`)
- Import path errors in newly merged code
- API handler returning wrong response shape

To temporarily disable smoke tests while debugging:

```bash
skynet config set SKYNET_POST_MERGE_SMOKE false
```

### Pipeline auto-paused

The watchdog pauses the pipeline if main fails 2 consecutive smoke tests. Fix the underlying issue, then resume:

```bash
skynet resume
```

## License

MIT
