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

# Mission is now defined in .dev/mission.md (read by project-driver directly)
export SKYNET_PROJECT_VISION=""

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
export SKYNET_TASK_TAGS="FEAT FIX INFRA TEST NMI"
