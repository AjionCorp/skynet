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

# ---- Project Vision ----
# Fed to the project-driver agent for backlog generation and prioritization.
# Describe your project's mission, goals, and roadmap.
SKYNET_PROJECT_VISION="
# Project Vision
Describe your project's purpose and goals here.
The project-driver will use this to generate and prioritize tasks.
"

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
