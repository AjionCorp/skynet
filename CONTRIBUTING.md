# Contributing to Skynet

## Development Setup

```bash
git clone https://github.com/AjionCorp/skynet.git
cd skynet
pnpm install
pnpm dev:admin        # Admin dashboard on port 3100
pnpm typecheck        # Verify everything compiles
```

The pipeline state lives in `.dev/` (markdown files managed by bash scripts — don't edit these from TypeScript).

## Creating Custom Agent Plugins

Agent plugins live in `scripts/agents/`. Each plugin exports two functions:

```bash
# scripts/agents/my-agent.sh
agent_check() {
  # Return 0 if the agent is available, 1 if not.
  command -v my-ai-tool &>/dev/null
}

agent_run() {
  local prompt="$1"
  local log_file="${2:-/dev/null}"
  my-ai-tool "$prompt" >> "$log_file" 2>&1
}
```

The loader (`scripts/_agent.sh`) sources your plugin and calls `agent_check` before each `agent_run`. If `agent_check` is omitted, availability is assumed.

**Activate your plugin** in `.dev/skynet.config.sh`:

```bash
export SKYNET_AGENT_PLUGIN="/path/to/my-agent.sh"
# Or for built-ins: "claude", "codex", "auto" (default — tries Claude then Codex)
```

## Adding Notification Channels

Notification plugins live in `scripts/notify/`. Each defines a `notify_<channel>()` function. The dispatcher (`scripts/_notify.sh`) sources all plugins and calls enabled ones.

**Example: `scripts/notify/email.sh`**

```bash
#!/usr/bin/env bash
# notify/email.sh — Email notification channel plugin
notify_email() {
  local msg="$1"
  [ "${SKYNET_EMAIL_ENABLED:-false}" = "true" ] || return 0
  [ -n "${SKYNET_EMAIL_TO:-}" ] || return 0
  echo "$msg" | mail -s "Skynet" "$SKYNET_EMAIL_TO" 2>/dev/null || true
}
```

Enable it in config:

```bash
export SKYNET_NOTIFY_CHANNELS="telegram,email"
export SKYNET_EMAIL_ENABLED="true"
export SKYNET_EMAIL_TO="team@example.com"
```

## Custom Quality Gates

Quality gates run in order before any branch is merged. Define them as numbered `SKYNET_GATE_N` variables in `.dev/skynet.config.sh`:

```bash
export SKYNET_GATE_1="pnpm typecheck"                              # Required
# export SKYNET_GATE_2="pnpm lint"
# export SKYNET_GATE_3="npx playwright test e2e/smoke.spec.ts --reporter=list"
```

If any gate command exits non-zero, the branch is not merged. Gate 1 defaults to `$SKYNET_TYPECHECK_CMD` if unset.

## Dashboard Development

The dashboard spans two packages:

- **`packages/dashboard/`** (`@ajioncorp/skynet`) — shared handlers, components, types
- **`packages/admin/`** — Next.js 15 App Router frontend

### Handler pattern

Handlers use factory functions that return `{ GET, POST }` route handlers:

```typescript
// packages/dashboard/src/handlers/my-feature.ts
import type { SkynetConfig } from "../types";

export function createMyFeatureHandler(config: SkynetConfig) {
  return {
    GET: async () => {
      // Read state, return JSON
      return Response.json({ data: result, error: null });
    },
  };
}
```

Response shape is always `{ data, error }` — keep this in sync with `types.ts`.

### Component pattern

Components use the `useSkynet()` hook for the API prefix and `lucide-react` for icons:

```tsx
const { apiPrefix } = useSkynet();
const res = await fetch(`${apiPrefix}/my-feature`);
const { data, error } = await res.json();
```

### Adding admin pages

Create a new route in `packages/admin/src/app/` following Next.js App Router conventions. Wire up the handler in `packages/dashboard/src/handlers/index.ts`.

## Shell Script Rules

All scripts in `scripts/` must follow these rules:

1. **Source `_config.sh` first** — it loads env vars, paths, and helpers
2. **bash 3.2 compatible** (macOS default) — no `${VAR^^}`, no associative arrays, no `readarray`
3. **Use `mkdir` for locks** — atomic on all Unix, not file-based checks:
   ```bash
   if ! mkdir "$LOCK_DIR" 2>/dev/null; then
     echo "Already running"; exit 0
   fi
   trap 'rmdir "$LOCK_DIR"' EXIT
   ```
4. **Use `log()` for output** — consistent timestamped logging
5. **PID lock pattern** — write `$$` to `/tmp/skynet-{project}-{type}.lock`
6. **Race conditions matter** — multiple workers merge concurrently; always `git pull origin main` before committing
7. **Never modify `.dev/` state files from TypeScript** — only bash scripts touch those
