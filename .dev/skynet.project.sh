#!/usr/bin/env bash
# skynet.project.sh — Project-specific configuration for SKYNET itself (meta!)

export SKYNET_WORKER_CONTEXT="
# Skynet Pipeline — Project Conventions
# This project IS the pipeline itself. When working on it, you are improving the tool
# that runs you. Be especially careful about:
# - Shell script correctness (race conditions, lock handling, signal traps)
# - TypeScript handler security (no shell injection, proper input validation)
# - React component state management (match types to actual API response shapes)
# - Cross-platform compatibility (macOS + Linux)

## Repository Structure
- scripts/         — Bash workers (the pipeline engine)
- templates/       — Scaffolded into consumer projects by 'skynet init'
- packages/dashboard/ — @ajioncorp/skynet (React components + API handlers)
- packages/cli/    — @ajioncorp/skynet-cli (init, setup-agents, status)

## Key Patterns
- Factory functions for API handlers: createXxxHandler(config) -> GET/POST
- mkdir-based mutex locks (atomic on all Unix)
- PID lock files in /tmp/skynet-{project}-*.lock
- Markdown files as pipeline state (.dev/*.md)
- Config loaded from .dev/skynet.config.sh + .dev/skynet.project.sh

## Testing
- pnpm typecheck (both packages)
- No Playwright tests for skynet itself (yet)
"

export SKYNET_PROJECT_VISION="
# Skynet: AI-Powered Development Pipeline

## Mission
Build the most reliable, self-improving AI development pipeline. Skynet automates the entire
development cycle: task generation, implementation via AI agents, quality gates, and deployment.

## Core Goals
1. Rock-solid worker orchestration — no race conditions, no lost tasks, no zombie processes
2. Seamless Claude/Codex fallback — never idle due to auth issues
3. Beautiful monitoring dashboard — real-time visibility into pipeline health
4. Easy adoption — 'npx skynet init' and you're running
5. Self-improving — the pipeline should be able to improve itself

## Current Priorities
- Harden lock acquisition and task claiming across parallel workers
- Add comprehensive test suite for shell scripts and TypeScript handlers
- Improve dashboard UX: better error states, loading skeletons, responsive design
- Add webhook/notification integrations beyond Telegram
- Performance: lazy-load dashboard tabs, cache API responses
"

export SKYNET_WORKER_CONVENTIONS="
Follow existing code patterns exactly:
- Shell scripts: use _config.sh sourcing, log() function, PID lock pattern
- Handlers: use factory function pattern, return { data, error } shape
- Components: use useSkynet() hook for API prefix, lucide-react for icons
- Keep handler response shapes in sync with types.ts interfaces
"

# Sync endpoints — none for skynet (it's a tool, not a data app)
export SKYNET_SYNC_ENDPOINTS=()

# Task tags
export SKYNET_TASK_TAGS="FEAT FIX INFRA TEST"
