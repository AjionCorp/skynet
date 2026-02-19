# Blockers

## Resolved

- **2026-02-19**: Playwright gate ran unconditionally even when `SKYNET_PLAYWRIGHT_DIR` and `SKYNET_SMOKE_TEST` were empty in skynet.config.sh. This caused ALL 10 initial tasks to fail with "playwright tests failed". **Fixed in commit `e317ed1`** — gates now skip when config vars are empty.

- **2026-02-19**: 14 tasks in failed-tasks.md were pending retry by task-fixer after Playwright gate bug. Root cause resolved, most tasks retried and merged.

- **2026-02-19**: npm publish was blocked — CLI `init.ts` resolved scripts via `__dirname` relative to monorepo root, breaking npm installs. **Fixed in commit `1af6dd3`** — uses `import.meta.url` for portable path resolution, also fixed merge conflict markers in CLI files.

## Active

None
