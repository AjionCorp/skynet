import { readFileSync, writeFileSync, existsSync, renameSync } from "fs";
import type { SkynetConfig } from "../types";
import { parseBody } from "../lib/parse-body";

/**
 * Parse a skynet.config.sh file into key-value pairs.
 * Extracts `export VAR="value"` and `export VAR=value` lines.
 * Preserves comments for context.
 */
function parseConfigFile(raw: string): { key: string; value: string; comment: string }[] {
  const entries: { key: string; value: string; comment: string }[] = [];
  const lines = raw.split("\n");
  let pendingComment = "";

  for (const line of lines) {
    const trimmed = line.trim();

    // Accumulate comment lines (section headers and inline docs)
    if (trimmed.startsWith("#")) {
      const commentText = trimmed.replace(/^#+\s*/, "").trim();
      if (commentText.startsWith("----")) {
        // Section header like "# ---- Project Identity ----"
        pendingComment = commentText.replace(/^-+\s*/, "").replace(/\s*-+$/, "").trim();
      } else if (commentText && !commentText.startsWith("!") && !commentText.startsWith("Generated")) {
        pendingComment = commentText;
      }
      continue;
    }

    // Match export lines: export KEY="value" or export KEY=value
    const exportMatch = trimmed.match(/^export\s+([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (exportMatch) {
      const key = exportMatch[1];
      let value = exportMatch[2];
      // Strip surrounding quotes
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      entries.push({ key, value, comment: pendingComment });
      pendingComment = "";
      continue;
    }

    // Blank line resets pending comment
    if (trimmed === "") {
      pendingComment = "";
    }
  }

  return entries;
}

/**
 * Write key-value pairs back to a skynet.config.sh file.
 * Preserves the original file structure — only updates values of existing keys.
 */
function writeConfigFile(configPath: string, updates: Record<string, string>): void {
  const raw = readFileSync(configPath, "utf-8");
  const lines = raw.split("\n");
  const result: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    const exportMatch = trimmed.match(/^export\s+([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (exportMatch && exportMatch[1] in updates) {
      const key = exportMatch[1];
      const newValue = updates[key].replace(/["\\$`\n\r]/g, (ch) => {
        if (ch === "\n") return "\\n";
        if (ch === "\r") return "\\r";
        return "\\" + ch;
      });
      result.push(`export ${key}="${newValue}"`);
    } else {
      result.push(line);
    }
  }

  const tmpPath = configPath + ".tmp";
  writeFileSync(tmpPath, result.join("\n"), "utf-8");
  renameSync(tmpPath, configPath);
}

const MUTABLE_KEYS = new Set([
  "SKYNET_MAX_WORKERS",
  "SKYNET_MAX_FIXERS",
  "SKYNET_MAX_TASKS_PER_RUN",
  "SKYNET_STALE_MINUTES",
  "SKYNET_AGENT_TIMEOUT_MINUTES",
  "SKYNET_MAX_FIX_ATTEMPTS",
  "SKYNET_FIXER_IGNORE_USAGE_LIMIT",
  "SKYNET_DRIVER_BACKLOG_THRESHOLD",
  "SKYNET_HEALTH_ALERT_THRESHOLD",
  "SKYNET_MAX_LOG_SIZE_KB",
  "SKYNET_MAX_EVENTS_LOG_KB",
  "SKYNET_WATCHDOG_INTERVAL",
  "SKYNET_ONE_SHOT",
  "SKYNET_POST_MERGE_SMOKE",
  "SKYNET_SMOKE_TIMEOUT",
  "SKYNET_POST_MERGE_TYPECHECK",
  "SKYNET_GIT_PUSH_TIMEOUT",
  "SKYNET_TG_ENABLED",
  "SKYNET_TG_BOT_TOKEN",
  "SKYNET_TG_CHAT_ID",
  "SKYNET_SLACK_WEBHOOK_URL",
  "SKYNET_DISCORD_WEBHOOK_URL",
  "SKYNET_NOTIFY_CHANNELS",
  "SKYNET_DEV_SERVER_CMD",
  "SKYNET_DEV_SERVER_URL",
  "SKYNET_DEV_PORT",
  "SKYNET_TYPECHECK_CMD",
  "SKYNET_LINT_CMD",
  "SKYNET_INSTALL_CMD",
  "SKYNET_GATE_1",
  "SKYNET_GATE_2",
  "SKYNET_GATE_3",
  "SKYNET_BRANCH_PREFIX",
  "SKYNET_CLAUDE_FLAGS",
  "SKYNET_CODEX_FLAGS",
  "SKYNET_CODEX_MODEL",
  "SKYNET_AGENT_PLUGIN",
]);

/**
 * Validate config updates — reject dangerous values.
 */
function validateUpdates(updates: Record<string, string>): string | null {
  for (const [key, value] of Object.entries(updates)) {
    if (typeof key !== "string" || typeof value !== "string") {
      return `Invalid type for key "${key}"`;
    }
    // Block shell injection: no backticks, $(), ${}, semicolons, pipes, ampersands, redirects, parens, newlines, or quotes.
    // Note: bare $VAR references are intentionally allowed — bash will expand them when sourcing.
    // Only $() and ${} command/brace expansion are blocked for security.
    if (/[`"'|&><()]|\$[({]|;|\n|\r/.test(value)) {
      return `Unsafe characters in value for "${key}"`;
    }
    // Key must be a valid bash variable name
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
      return `Invalid config key "${key}"`;
    }
    // Only allow known mutable config keys
    if (!MUTABLE_KEYS.has(key)) {
      return `Key '${key}' is not in the list of updatable configuration keys`;
    }
    // Key-specific validation
    if (key === "SKYNET_MAX_WORKERS") {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1) {
        return `SKYNET_MAX_WORKERS must be a positive integer, got "${value}"`;
      }
    }
    if (key === "SKYNET_STALE_MINUTES") {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 5) {
        return `SKYNET_STALE_MINUTES must be an integer >= 5, got "${value}"`;
      }
    }
  }
  return null;
}

/**
 * Create GET and POST handlers for the config endpoint.
 *
 * GET: Parse skynet.config.sh and return key-value pairs.
 * POST: Validate and write updated values back.
 */
export function createConfigHandler(config: SkynetConfig) {
  const configPath = `${config.devDir}/skynet.config.sh`;

  async function GET(): Promise<Response> {
    try {
      if (!existsSync(configPath)) {
        return Response.json({
          data: { entries: [], configPath },
          error: null,
        });
      }

      const raw = readFileSync(configPath, "utf-8");
      const entries = parseConfigFile(raw);

      return Response.json({
        data: { entries, configPath },
        error: null,
      });
    } catch (err) {
      return Response.json(
        {
          data: null,
          error: err instanceof Error ? err.message : "Failed to read config",
        },
        { status: 500 }
      );
    }
  }

  async function POST(request: Request): Promise<Response> {
    try {
      if (!existsSync(configPath)) {
        return Response.json(
          { data: null, error: "Config file not found" },
          { status: 404 }
        );
      }

      const { data: body, error: parseError, status: parseStatus } = await parseBody<{ updates: Record<string, string> }>(request);
      if (parseError || !body) {
        return Response.json({ data: null, error: parseError }, { status: parseStatus ?? 400 });
      }
      const { updates } = body;

      if (!updates || typeof updates !== "object") {
        return Response.json(
          { data: null, error: "Missing 'updates' object in request body" },
          { status: 400 }
        );
      }

      const validationError = validateUpdates(updates);
      if (validationError) {
        return Response.json(
          { data: null, error: validationError },
          { status: 400 }
        );
      }

      writeConfigFile(configPath, updates);

      // Re-read to return updated state
      const raw = readFileSync(configPath, "utf-8");
      const entries = parseConfigFile(raw);

      return Response.json({
        data: { entries, configPath, updatedKeys: Object.keys(updates) },
        error: null,
      });
    } catch (err) {
      return Response.json(
        {
          data: null,
          error: err instanceof Error ? err.message : "Failed to update config",
        },
        { status: 500 }
      );
    }
  }

  return { GET, POST };
}
