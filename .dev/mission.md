# LLM Provider Selection in Mission Admin

## Purpose
Enable operators to choose which LLM provider/model executes tasks for each mission, giving fine-grained control over cost, capability, and performance trade-offs directly from the mission admin page.

## Goals
- [x] Add an LLM provider/model selector to the mission creation and editing UI in the admin dashboard — Done (commit c4cfab9, MissionDashboard.tsx LLM Configuration Panel with provider dropdown and model input)
- [x] Persist the selected LLM configuration per mission in the mission state files — Done (commit 76a237c, missions.ts + mission-detail.ts + mission-assignments.ts)
- [x] Pass the selected LLM configuration through to the worker pipeline so tasks execute with the chosen model — Done (commit fb85a0d, _get_mission_llm_config in _config.sh, threaded into dev-worker.sh line 593 and task-fixer.sh line 429, SKYNET_CLAUDE_MODEL + --model flag in agents/claude.sh)
- [x] Support at least the primary Claude model tiers (Opus, Sonnet, Haiku) as selectable options — Done (LlmConfig type in types.ts, UI dropdown with auto/claude/codex/gemini providers, model field supports opus/sonnet/haiku)
- [x] Display the currently selected LLM on the mission dashboard for visibility — Done (commit c4cfab9, model badge on mission cards + LLM config panel in detail view)

## Success Criteria
- [x] Admin user can select an LLM model from a dropdown when creating or editing a mission — Done (MissionDashboard.tsx LLM Configuration Panel, commit c4cfab9)
- [x] The selected model is saved and persisted across page reloads — Done (handler persistence in missions.ts/mission-detail.ts/mission-assignments.ts, commit 76a237c)
- [x] Workers spawned for the mission use the selected LLM model for code execution — Done (_get_mission_llm_config reads per-mission config, exports SKYNET_CLAUDE_MODEL, --model flag passed to Claude agent, commit fb85a0d)
- [x] Default model is pre-selected when no explicit choice is made — Done (MissionDashboard.tsx uses ?? "auto" fallback at line 899 and ?? { provider: "auto" } at line 887)
- [x] The mission detail view shows which LLM is assigned to the mission — Done (provider badge on mission cards + LLM Configuration Panel, commit c4cfab9)
- [x] pnpm typecheck passes with all changes — Verified clean 2026-03-03

## Mission Complete

**Completed: 2026-03-03**

All 5 goals achieved. All 6 success criteria met and verified on main.

Key commits: d143fb3 (LlmConfig type), e895eb9 (SKYNET_CLAUDE_MODEL + --model flag), 76a237c (handler persistence), fb85a0d (_get_mission_llm_config shell helper + worker threading), c4cfab9 (UI selector + badge).

After 12+ consecutive LLM task failures in earlier attempts, the ultra-precise 5-task decomposition with file-scope constraints broke the cycle. Lessons: exact file-scope constraints, additive-only optional fields, mandatory git pull origin main, embedded "DO NOT touch" guardrails.