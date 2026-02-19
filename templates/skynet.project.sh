#!/usr/bin/env bash
# skynet.project.sh — Project-specific pipeline content
# This file is safe to commit — it contains no secrets.
# Edit this to customize how Skynet works with YOUR project.

# ---- Worker Prompt Context ----
# Appended to the prompt when dev-worker invokes Claude Code.
# Include your project's conventions, available data, debugging tips, etc.
SKYNET_WORKER_CONTEXT="
# Project Conventions
- Use TypeScript strict mode
- Follow existing patterns in the codebase

# Add your project-specific context here...
"

# ---- Project Vision (fallback) ----
# The project-driver primarily reads .dev/mission.md for strategic direction.
# This variable is only used as a fallback if mission.md doesn't exist.
# Edit .dev/mission.md instead — it supports richer formatting and is easier to maintain.
SKYNET_PROJECT_VISION=""

# ---- Sync Endpoints ----
# Format: "name|path" — used by sync-runner to hit your API endpoints
# Leave empty if your project has no sync endpoints
SKYNET_SYNC_ENDPOINTS=()

# Static sync entries (data already loaded, no API call needed)
# Format: "name|status|type|notes"
SKYNET_SYNC_STATIC=()

# ---- Task Tags ----
# Available tags for categorizing backlog items
SKYNET_TASK_TAGS="FEAT FIX INFRA TEST"
