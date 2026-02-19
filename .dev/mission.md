# Skynet Mission

## Purpose

Skynet is an autonomous AI development pipeline that leverages LLM agents via terminals to build, test, ship, and self-correct software — continuously and without human intervention until the mission is achieved.

## Core Mission

Build a self-improving ecosystem where AI agents:
1. **Execute** — Claim tasks, implement code, run quality gates, merge to main
2. **Self-correct** — Detect failures, diagnose root causes, fix them automatically
3. **Self-improve** — Identify gaps in the pipeline itself, generate tasks to fix them, then execute those tasks
4. **Interface** — Connect to any system (git, CI, APIs, notifications, databases) needed to achieve the goal
5. **Persist** — Run continuously via launchd/cron, recover from crashes, never lose state

## Skynet's Own Goal

Skynet must improve itself into a flawless utility that any project can adopt:

- `npx skynet init` → scaffolds `.dev/`, config, mission, backlog
- `npx skynet setup-agents` → installs launchd/cron workers
- Define a `mission.md` → the pipeline drives toward it autonomously
- Workers implement tasks, quality gates catch failures, task-fixer retries, project-driver replenishes
- The loop runs until the mission is achieved or the backlog is empty

## Architecture Principles

- **mission.md is the source of truth** — every task should trace back to advancing the mission
- **Markdown as state** — backlog.md, completed.md, failed-tasks.md, blockers.md are the database
- **Shell scripts as orchestration** — portable, debuggable, zero dependencies beyond bash + git
- **LLM agents as workers** — Claude Code primary, Codex CLI fallback, extensible to any agent
- **Dashboard as visibility** — React components + API handlers, importable into any Next.js app
- **Config-driven** — everything parameterized via skynet.config.sh + mission.md

## Success Criteria

Skynet is complete when:
1. Any project can go from zero to autonomous AI development in under 5 minutes
2. The pipeline self-corrects 95%+ of failures without human intervention
3. Workers never lose tasks, deadlock, or produce zombie processes
4. The dashboard provides full real-time visibility into pipeline health
5. Mission progress is measurable — completed tasks map to mission objectives
6. The system works with any LLM agent (Claude, Codex, future models)

## Current Focus Areas

1. **Reliability** — Lock handling, task claiming, crash recovery, stale detection
2. **Self-correction loop** — task-fixer → health-check → project-driver feedback cycle
3. **Mission-driven planning** — project-driver reads mission.md, generates tasks that advance it
4. **Portability** — works on macOS + Linux, launchd + cron, any terminal-accessible LLM
5. **Developer experience** — clean CLI, fast setup, clear docs, beautiful dashboard
6. **Extensibility** — hooks, custom workers, pluggable notification channels, API integrations
