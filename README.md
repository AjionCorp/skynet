# Skynet

Autonomous AI development pipeline. Uses Claude Code as the coding agent, bash scripts as workers, markdown files as state, and a Next.js dashboard for monitoring.

Drop it into any project. Define a mission. Let it build.

## How It Works

```
LaunchAgents (macOS) / cron (Linux)
  └── watchdog (every 3m)
        ├── dev-worker-1    Pick task → worktree → Claude Code → typecheck → test → merge
        ├── dev-worker-2    (parallel worker, isolated worktree)
        ├── task-fixer      Retry failed tasks (up to 3 attempts)
        └── project-driver  Read mission.md → generate + prioritize backlog

  └── ui-tester (every 1h)         Playwright smoke tests
  └── feature-validator (every 2h) Deep feature tests
  └── health-check (daily)         Typecheck + lint + auto-fix
  └── sync-runner (every 6h)       Hit API sync endpoints
  └── auth-refresh (every 30m)     Claude Code OAuth token refresh
```

**State** lives in `.dev/` as markdown: `backlog.md`, `completed.md`, `failed-tasks.md`, `blockers.md`, `mission.md`

**Workers** use git worktrees for full isolation -- two workers can run in parallel on different branches without conflicts.

---

## Integrating Skynet Into Your Project

### Prerequisites

- **macOS** (for LaunchAgents + Keychain auth) or Linux (manual/cron mode)
- **Node.js 18+** and **pnpm** (or npm/yarn -- configure commands accordingly)
- **Git** repository initialized in your project
- **Claude Code CLI** installed and authenticated (`claude` command available)

### Step 1: Clone Skynet

```bash
# Clone the skynet repo somewhere on your machine
git clone https://github.com/AjionCorp/skynet.git ~/skynet

# Install dependencies
cd ~/skynet && pnpm install
```

### Step 2: Initialize in Your Project

```bash
cd /path/to/your/project

# Run the interactive init wizard
node ~/skynet/packages/cli/src/index.ts init
```

The wizard will ask for:

| Prompt | Example | Notes |
|--------|---------|-------|
| Project name | `my-app` | Lowercase, alphanumeric + hyphens |
| Dev server command | `pnpm dev` | How to start your dev server |
| Dev server port | `3000` | For health checks and Playwright |
| Typecheck command | `pnpm typecheck` | Quality gate before merge |
| Lint command | `pnpm lint` | Used by health-check worker |
| Playwright directory | `e2e` | Relative path, or blank to skip |
| Main branch | `main` | Branch workers merge into |
| Telegram bot token | _(optional)_ | For pipeline notifications |
| Telegram chat ID | _(optional)_ | Your chat or group ID |

This creates:

```
your-project/
├── .dev/
│   ├── skynet.config.sh        # Machine-specific config (gitignored)
│   ├── skynet.project.sh       # Project config (commit this)
│   ├── mission.md              # Your project's mission (commit this)
│   ├── backlog.md              # Task queue
│   ├── current-task.md         # Active task tracker
│   ├── completed.md            # Completed task log
│   ├── failed-tasks.md         # Failed task audit trail
│   ├── blockers.md             # Active blockers
│   ├── sync-health.md          # Sync endpoint health
│   └── scripts/                # Symlinked worker scripts
│       ├── _config.sh
│       ├── _agent.sh
│       ├── dev-worker.sh
│       ├── watchdog.sh
│       └── ...
```

### Step 3: Define Your Mission

Edit `.dev/mission.md` -- this is the most important file. The project-driver reads it to generate tasks.

```markdown
# My App Mission

## Purpose
What your project does and why it exists.

## Goals
1. Build feature X with full CRUD
2. Add authentication with OAuth
3. Create a public API with rate limiting

## Success Criteria
1. All pages load without errors
2. Test coverage above 80%
3. API response times under 200ms

## Current Focus
1. Core data models and API routes
2. Authentication flow
```

### Step 4: Configure Project Context

Edit `.dev/skynet.project.sh` to give the AI agents context about your project:

```bash
export SKYNET_WORKER_CONTEXT="
# My App -- Project Conventions

## Stack
- Next.js 15 with App Router
- Supabase for database
- Tailwind CSS for styling

## Patterns
- API routes go in src/app/api/
- Components in src/components/
- Use server actions for mutations

## Important
- Always use TypeScript strict mode
- Run 'pnpm typecheck' before committing
"

export SKYNET_WORKER_CONVENTIONS="
- Follow existing code patterns
- Use the established naming conventions
- Do not modify .dev/ files
"
```

### Step 5: Authenticate Claude Code

Claude Code must be authenticated on the machine that will run the pipeline:

```bash
# Open Claude Code and log in
claude
# Inside Claude: /login

# Verify auth works
claude --print "echo hello"
```

For persistent auth (required for LaunchAgents), the auth-refresh worker will keep the token alive via macOS Keychain. The init wizard configures the keychain service name automatically.

### Step 6: Seed the Backlog

Add your first tasks to `.dev/backlog.md`:

```markdown
# Backlog

<!-- Priority: top = highest. Format: - [ ] [TAG] Task title -- description -->

- [ ] [FEAT] Create user model and API routes -- add Prisma schema for User, create CRUD endpoints at /api/users
- [ ] [FEAT] Add login page -- create /login with email/password form, call /api/auth/login
- [ ] [TEST] Add API tests for user endpoints -- test GET/POST/PUT/DELETE with edge cases
```

Tags: `[FEAT]` features, `[FIX]` bugs, `[INFRA]` infrastructure, `[TEST]` tests, `[DATA]` data/sync

Or skip this -- the project-driver will generate tasks from your `mission.md` automatically.

### Step 7: Start the Pipeline

**Option A: Install LaunchAgents (recommended for persistent operation)**

```bash
node ~/skynet/packages/cli/src/index.ts setup-agents
```

This installs macOS LaunchAgents that auto-start on login. Workers run on schedule:
- Watchdog every 3 minutes (dispatches idle workers)
- Auth refresh every 30 minutes
- Health check daily

**Option B: Run manually**

```bash
# Run the watchdog once (kicks off workers if there's work)
bash .dev/scripts/watchdog.sh

# Or run a single worker directly
bash .dev/scripts/dev-worker.sh 1

# Check status
node ~/skynet/packages/cli/src/index.ts status
```

### Step 8: Monitor

```bash
# Quick terminal status
node ~/skynet/packages/cli/src/index.ts status

# Watch worker logs
tail -f .dev/scripts/dev-worker-1.log

# Check what's happening
cat .dev/current-task-1.md
cat .dev/backlog.md
cat .dev/completed.md
```

If you configured Telegram, you'll get notifications for task starts, completions, and failures.

---

## Updating Skynet

When new features or fixes land in the skynet repo:

```bash
# Pull latest
cd ~/skynet
git pull origin main
pnpm install

# Re-link scripts in your project (init skips existing config files)
cd /path/to/your/project
node ~/skynet/packages/cli/src/index.ts init --name your-project

# Reload LaunchAgents if installed
node ~/skynet/packages/cli/src/index.ts setup-agents
```

The init command is idempotent -- it won't overwrite existing config or state files, only re-symlinks the scripts.

---

## Configuration Reference

### `skynet.config.sh` (machine-specific, gitignored)

Generated by `init`. Contains paths, secrets, and tuning:

```bash
SKYNET_PROJECT_NAME="myproject"
SKYNET_PROJECT_DIR="/Users/me/myproject"
SKYNET_DEV_DIR="/Users/me/myproject/.dev"
SKYNET_DEV_SERVER_CMD="pnpm dev"
SKYNET_DEV_SERVER_URL="http://localhost:3000"
SKYNET_TYPECHECK_CMD="pnpm typecheck"
SKYNET_LINT_CMD="pnpm lint"
SKYNET_MAIN_BRANCH="main"
SKYNET_MAX_WORKERS=2               # Parallel dev workers
SKYNET_MAX_TASKS_PER_RUN=5         # Tasks per worker invocation
SKYNET_STALE_MINUTES=45            # Auto-fail stuck tasks
SKYNET_MAX_FIX_ATTEMPTS=3          # task-fixer retries before blocking
SKYNET_TG_BOT_TOKEN="..."          # Telegram notifications (optional)
SKYNET_TG_CHAT_ID="..."
SKYNET_CLAUDE_BIN="claude"
SKYNET_CLAUDE_FLAGS="--print --dangerously-skip-permissions"
SKYNET_AGENT_PREFERENCE="auto"     # claude | codex | auto (fallback)
```

### `skynet.project.sh` (project-specific, committable)

```bash
SKYNET_WORKER_CONTEXT="..."         # Injected into every agent prompt
SKYNET_WORKER_CONVENTIONS="..."     # Style rules appended to prompts
SKYNET_PROJECT_VISION="..."         # Fallback if mission.md doesn't exist
SKYNET_SYNC_ENDPOINTS=(...)         # API endpoints for sync-runner
SKYNET_TASK_TAGS="FEAT FIX INFRA TEST"
```

---

## Dashboard (Optional)

Skynet includes React components and API handlers you can mount in any Next.js app.

### Mount API Routes

```typescript
// app/api/admin/pipeline/status/route.ts
import { createPipelineStatusHandler, createConfig } from "@ajioncorp/skynet";

const config = createConfig({
  projectName: "myproject",
  devDir: process.cwd() + "/.dev",
  lockPrefix: "/tmp/skynet-myproject",
});

export const GET = createPipelineStatusHandler(config);
```

### Mount Pages

```tsx
// app/admin/pipeline/page.tsx
import { PipelineDashboard } from "@ajioncorp/skynet";

export default function Page() {
  return <PipelineDashboard />;
}
```

### Available Components

| Component | Description |
|-----------|-------------|
| `PipelineDashboard` | Worker status, triggers, logs, backlog |
| `MonitoringDashboard` | Workers, tasks, logs, system health |
| `TasksDashboard` | Backlog management with create-task form |
| `SyncDashboard` | Data sync health overview |
| `PromptsDashboard` | View worker prompt templates |
| `AdminLayout` | Reusable admin layout with nav tabs |

### Available Handlers

| Handler | Method | Description |
|---------|--------|-------------|
| `createPipelineStatusHandler` | GET | Full pipeline state |
| `createPipelineTriggerHandler` | POST | Trigger a worker script |
| `createPipelineLogsHandler` | GET | Read worker log files |
| `createMonitoringStatusHandler` | GET | Extended status with git + auth info |
| `createMonitoringAgentsHandler` | GET | LaunchAgent status |
| `createMonitoringLogsHandler` | GET | Logs with search support |
| `createTasksHandlers` | GET/POST | Read backlog + create tasks |
| `createPromptsHandler` | GET | Extract prompt templates from scripts |

---

## Workers

| Worker | Trigger | What It Does |
|--------|---------|-------------|
| **Dev Worker** | Watchdog (when backlog has tasks) | Claims task, creates git worktree, invokes Claude Code, runs typecheck + Playwright, merges on success |
| **Task Fixer** | Watchdog (when failed tasks exist) | Retries failed tasks with error context, up to 3 attempts |
| **Project Driver** | Watchdog (when backlog < 5 tasks) | Reads mission.md, generates and prioritizes new backlog tasks |
| **Watchdog** | Every 3 minutes | Dispatches idle workers, checks auth, manages pipeline |
| **UI Tester** | Every 1 hour | Runs Playwright smoke tests, creates fix tasks on failure |
| **Feature Validator** | Every 2 hours | Deep Playwright feature tests |
| **Health Check** | Daily | Typecheck + lint with Claude auto-fix loop |
| **Sync Runner** | Every 6 hours | Hits configured API sync endpoints |
| **Auth Refresh** | Every 30 minutes | Refreshes Claude Code OAuth token from macOS Keychain |

---

## Project Structure

```
skynet/
├── scripts/              # Bash workers (the pipeline engine)
│   ├── _config.sh        # Universal config loader
│   ├── _agent.sh         # Claude/Codex abstraction (run_agent)
│   ├── _notify.sh        # Telegram notifications (tg, tg_throttled)
│   ├── _compat.sh        # Cross-platform helpers (bash 3.2 compat)
│   ├── dev-worker.sh     # Main coding worker (worktree-based)
│   ├── task-fixer.sh     # Failed task retry worker
│   ├── project-driver.sh # Mission-driven task generator
│   ├── watchdog.sh       # Dispatcher / health monitor
│   └── ...               # Other workers
├── templates/            # Scaffolded into projects by `skynet init`
│   ├── launchagents/     # macOS LaunchAgent plist templates
│   └── *.md              # State file templates
├── packages/
│   ├── dashboard/        # React components + API handlers
│   ├── cli/              # CLI: init, setup-agents, status
│   └── admin/            # Reference admin app (Next.js)
```

## Requirements

- macOS (for LaunchAgents and Keychain auth) or Linux (cron mode)
- Node.js 18+, pnpm
- Claude Code CLI (`claude`) authenticated
- Git
- Playwright (optional, for test workers)

## License

MIT
