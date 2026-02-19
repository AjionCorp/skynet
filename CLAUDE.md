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

Workflow Orchestration
1. Plan Mode Default
Enter plan mode for ANY non-trivial task (3+ steps or architectural decisions)
If something goes sideways, STOP and re-plan immediately – don't keep pushing
Use plan mode for verification steps, not just building
Write detailed specs upfront to reduce ambiguity
2. Subagent Strategy
Use subagents liberally to keep main context window clean
Offload research, exploration, and parallel analysis to subagents
For complex problems, throw more compute at it via subagents
One task per subagent for focused execution
3. Self-Improvement Loop
After ANY correction from the user: update tasks/lessons.md with the pattern
Write rules for yourself that prevent the same mistake
Ruthlessly iterate on these lessons until mistake rate drops
Review lessons at session start for relevant project
4. Verification Before Done
Never mark a task complete without proving it works
Diff behavior between main and your changes when relevant
Ask yourself: "Would a staff engineer approve this?"
Run tests, check logs, demonstrate correctness
5. Demand Elegance (Balanced)
For non-trivial changes: pause and ask "is there a more elegant way?"
If a fix feels hacky: "Knowing everything I know now, implement the elegant solution"
Skip this for simple, obvious fixes – don't over-engineer
Challenge your own work before presenting it
6. Autonomous Bug Fixing
When given a bug report: just fix it. Don't ask for hand-holding
Point at logs, errors, failing tests – then resolve them
Zero context switching required from the user
Go fix failing CI tests without being told how
Task Management
Plan First: Write plan to tasks/todo.md with checkable items
Verify Plan: Check in before starting implementation
Track Progress: Mark items complete as you go
Explain Changes: High-level summary at each step
Document Results: Add review section to tasks/todo.md
Capture Lessons: Update tasks/lessons.md after corrections
Core Principles
Simplicity First: Make every change as simple as possible. Impact minimal code.
No Laziness: Find root causes. No temporary fixes. Senior developer standards.
Minimal Impact: Changes should only touch what's necessary. Avoid introducing bugs.
