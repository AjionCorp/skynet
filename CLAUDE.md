# Skynet — Claude Code Instructions

## Overview
Skynet is an autonomous AI dev pipeline by AjionCorp. Bash workers claim tasks
from `.dev/backlog.md`, implement via Claude Code in git worktrees, pass quality
gates, and merge to main. This repo IS the pipeline — changes here affect the
tool that runs you.

## Tech Stack
- **Pipeline engine**: Bash scripts (`scripts/`) with mkdir-based mutex locks
- **Dashboard**: Next.js 15 (App Router) + React 19 + TypeScript (`packages/admin/`)
- **Shared lib**: `@ajioncorp/skynet` — handlers, components, types (`packages/dashboard/`)
- **CLI**: `@ajioncorp/skynet-cli` — init, add-task, status, doctor (`packages/cli/`)
- **Package manager**: pnpm workspaces

## Key Patterns
- Factory handlers: `createXxxHandler(config)` returning GET/POST
- PID lock files: `/tmp/skynet-{project}-{type}.lock`
- Atomic locks: `mkdir` mutex (works cross-platform)
- State files: `.dev/*.md` (backlog, completed, failed-tasks, blockers, mission)
- Config: `.dev/skynet.config.sh` + `.dev/skynet.project.sh`
- Workers get their own git worktree in `/tmp/skynet-{project}-worktree-*`

## Commands
- `pnpm typecheck` — Type-check all packages (the primary quality gate)
- `pnpm dev:admin` — Admin dashboard on port 3100
- `bash scripts/watchdog.sh` — Dispatch workers based on backlog/failed counts
- `bash scripts/dev-worker.sh N` — Run dev worker instance N
- `bash scripts/task-fixer.sh N` — Run task fixer instance N

## Shell Script Rules
- Always source `_config.sh` first (loads all env vars and paths)
- Use `log()` for output, PID lock pattern for singleton enforcement
- bash 3.2 compatible (macOS) — no `${VAR^^}`, no associative arrays
- Race conditions matter: use mkdir locks, not file-based checks

## Guidelines
- Prefer editing existing files over creating new ones
- Handler response shape: `{ data, error }` — keep in sync with `types.ts`
- Components use `useSkynet()` hook for API prefix, `lucide-react` for icons
- Do not modify `.dev/` state files from TypeScript — only bash scripts touch those
- Run `pnpm typecheck` before considering any change complete

## Self-Modifying Codebase Warning
You are editing the pipeline that runs you. Extra caution required:
- Never break lock handling, the claiming protocol, or signal traps
- Understand the full worker lifecycle before changing `scripts/` files
- Shell script bugs here crash all workers — test thoroughly

## Concurrent Worker Safety
Multiple workers merge to main simultaneously. You must:
- `git pull origin main` before committing to avoid merge conflicts
- Never modify `current-task-N.md` for a different worker's N
- Never touch lock files or write to `backlog.md` from TypeScript
- Never write to `.dev/` state files — the bash pipeline owns those

## Verification Before Done
- Never mark a task complete without proving it works
- Run `pnpm typecheck` — fix any errors (up to 3 attempts)
- curl your new API routes against the dev server to verify runtime behavior
- Check dev server logs for 500s: `cat .dev/scripts/next-dev-w*.log | tail -50`
- Ask yourself: "Would a staff engineer approve this?"

## Autonomous Bug Fixing
- When given a bug: just fix it. Don't ask for hand-holding
- Point at logs, errors, failing tests — then resolve them
- Zero context switching required from the user

## Interactive Session Workflow (not for pipeline workers)
1. Plan mode for ANY non-trivial task (3+ steps or architectural decisions)
2. If something goes sideways, STOP and re-plan — don't keep pushing
3. Use subagents for research and parallel analysis
4. After user corrections: capture the lesson to avoid repeating it

## Core Principles
- Simplicity First: minimal changes, minimal code, minimal blast radius
- No Laziness: find root causes, no temporary fixes, senior engineer standards
- Demand Elegance: for non-trivial changes, pause and find the clean solution
- Skip over-engineering for simple obvious fixes
