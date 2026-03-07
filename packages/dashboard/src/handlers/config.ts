import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync, rmSync, statSync } from "fs";
import type { SkynetConfig } from "../types";
import { parseBody } from "../lib/parse-body";
import { VALID_CONFIG_KEY } from "../lib/constants";
import { logHandlerError } from "../lib/handler-error";

/**
 * Parse a skynet.config.sh file into key-value pairs.
 * Extracts `export VAR="value"` and `export VAR=value` lines.
 * Preserves comments for context.
 *
 * NOTE: Multi-line values (backslash continuation, heredocs) are NOT supported.
 * Each export must be on a single line.
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
      if (value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1);
        // Unescape bash double-quote escape sequences.
        // LIMITATION: Only \" and \\ are handled. Multi-line values and special
        // escape sequences (\t, \a, \b, \f, \v) are not supported — each export
        // must be a single line with simple quoting.
        value = value.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      } else if (value.startsWith("'") && value.endsWith("'")) {
        value = value.slice(1, -1);
        // Single-quoted values have no escape sequences in bash
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
function writeConfigFile(configPath: string, updates: Record<string, string>): string[] {
  const raw = readFileSync(configPath, "utf-8");
  const lines = raw.split("\n");
  const result: string[] = [];
  const matchedKeys = new Set<string>();

  for (const line of lines) {
    const trimmed = line.trim();
    const exportMatch = trimmed.match(/^export\s+([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (exportMatch && exportMatch[1] in updates) {
      const key = exportMatch[1];
      matchedKeys.add(key);
      // NOTE: validateUpdates() already rejects " and ` characters, so only
      // $, \, \n, and \r can actually reach this escaping logic.
      // IMPORTANT: Backslashes MUST be escaped first (separate pass) to avoid
      // double-escaping. If \ and $ were handled in one pass, input `\$` could
      // produce `\\$` (expands in shell) instead of the correct `\\\$`.
      const newValue = updates[key]
        .replace(/\\/g, "\\\\")
        .replace(/\$/g, "\\$")
        .replace(/\n/g, "\\n")
        .replace(/\r/g, "\\r");
      result.push(`export ${key}="${newValue}"`);
    } else {
      result.push(line);
    }
  }

  const tmpPath = configPath + ".tmp";
  writeFileSync(tmpPath, result.join("\n"), "utf-8");
  renameSync(tmpPath, configPath);

  // Return keys that were requested but not found in the file
  const missingKeys = Object.keys(updates).filter(k => !matchedKeys.has(k));
  return missingKeys;
}

/**
 * Keys that can be updated via the dashboard config POST endpoint.
 * Hardcoded (not derived from config template) because:
 * 1. Security: each key is manually reviewed for safety implications
 * 2. Stability: template changes shouldn't auto-expose new keys
 * 3. Auditability: git blame shows when each key was added
 */
export const MUTABLE_KEYS = new Set([
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
  "SKYNET_MAIN_BRANCH",
  "SKYNET_CLAUDE_BIN",
  "SKYNET_CLAUDE_MODEL",
  "SKYNET_CODEX_BIN",
  "SKYNET_CODEX_SUBCOMMAND",
  "SKYNET_CODEX_MODEL",
  "SKYNET_GEMINI_BIN",
  "SKYNET_GEMINI_FLAGS",
  "SKYNET_GEMINI_MODEL",
  "SKYNET_WORKER_CONTEXT",
  "SKYNET_WORKER_CONVENTIONS",
]);

/**
 * Keys whose values are eval'd as shell commands by workers.
 * Restricted to simple safe commands (alphanumeric, spaces, dots, slashes, hyphens, colons, equals).
 */
const EXECUTABLE_KEYS = new Set([
  "SKYNET_GATE_1", "SKYNET_GATE_2", "SKYNET_GATE_3",
  "SKYNET_INSTALL_CMD", "SKYNET_TYPECHECK_CMD", "SKYNET_LINT_CMD",
  "SKYNET_DEV_SERVER_CMD",
  "SKYNET_CLAUDE_BIN", "SKYNET_CODEX_BIN", "SKYNET_GEMINI_BIN",
]);

const BOOLEAN_KEYS = new Set([
  "SKYNET_FIXER_IGNORE_USAGE_LIMIT",
  "SKYNET_ONE_SHOT",
  "SKYNET_POST_MERGE_SMOKE",
  "SKYNET_POST_MERGE_TYPECHECK",
  "SKYNET_TG_ENABLED",
]);

const INTEGER_RULES: Partial<Record<string, { min: number; max: number }>> = {
  SKYNET_MAX_WORKERS: { min: 1, max: 16 },
  SKYNET_MAX_FIXERS: { min: 0, max: 16 },
  SKYNET_MAX_TASKS_PER_RUN: { min: 1, max: 100 },
  SKYNET_STALE_MINUTES: { min: 5, max: 240 },
  SKYNET_AGENT_TIMEOUT_MINUTES: { min: 0, max: 240 },
  SKYNET_MAX_FIX_ATTEMPTS: { min: 1, max: 20 },
  SKYNET_DRIVER_BACKLOG_THRESHOLD: { min: 0, max: 100 },
  SKYNET_HEALTH_ALERT_THRESHOLD: { min: 0, max: 100 },
  SKYNET_MAX_LOG_SIZE_KB: { min: 0, max: 102400 },
  SKYNET_MAX_EVENTS_LOG_KB: { min: 0, max: 102400 },
  SKYNET_WATCHDOG_INTERVAL: { min: 30, max: 600 },
  SKYNET_SMOKE_TIMEOUT: { min: 1, max: 600 },
  SKYNET_GIT_PUSH_TIMEOUT: { min: 1, max: 300 },
  SKYNET_DEV_PORT: { min: 1, max: 65535 },
};

const URL_RULES: Partial<Record<string, { protocols: string[]; allowEmpty?: boolean }>> = {
  SKYNET_DEV_SERVER_URL: { protocols: ["http:", "https:"] },
  SKYNET_SLACK_WEBHOOK_URL: { protocols: ["https:"], allowEmpty: true },
  SKYNET_DISCORD_WEBHOOK_URL: { protocols: ["https:"], allowEmpty: true },
};

const NOTIFY_CHANNELS = new Set(["telegram", "slack", "discord"]);

function validateIntegerValue(
  key: string,
  value: string,
  range: { min: number; max: number }
): string | null {
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    return `${key} must be an integer between ${range.min} and ${range.max}, got "${value}"`;
  }
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n) || n < range.min || n > range.max) {
    return `${key} must be an integer between ${range.min} and ${range.max}, got "${value}"`;
  }
  return null;
}

function validateBooleanValue(key: string, value: string): string | null {
  if (!/^(true|false)$/i.test(value.trim())) {
    return `${key} must be "true" or "false", got "${value}"`;
  }
  return null;
}

function validateUrlValue(
  key: string,
  value: string,
  rule: { protocols: string[]; allowEmpty?: boolean }
): string | null {
  const protocolLabel = rule.protocols.join(" or ");
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return rule.allowEmpty ? null : `${key} must be a valid ${protocolLabel} URL`;
  }
  try {
    const parsed = new URL(trimmed);
    if (!rule.protocols.includes(parsed.protocol)) {
      return `${key} must use ${protocolLabel} (got "${parsed.protocol}")`;
    }
    return null;
  } catch {
    return `${key} must be a valid ${protocolLabel} URL`;
  }
}

function validateNotifyChannelsValue(value: string): string | null {
  const channels = value
    .split(",")
    .map((channel) => channel.trim().toLowerCase())
    .filter(Boolean);

  if (channels.length === 0) return null;

  const invalid = channels.filter((channel) => !NOTIFY_CHANNELS.has(channel));
  if (invalid.length > 0) {
    return `SKYNET_NOTIFY_CHANNELS supports only telegram, slack, and discord (got "${invalid.join(", ")}")`;
  }
  return null;
}

function validateTelegramChatIdValue(value: string): string | null {
  if (value.trim().length === 0) return null;
  if (!/^-?\d+$/.test(value.trim())) {
    return `SKYNET_TG_CHAT_ID must be a numeric Telegram chat id, got "${value}"`;
  }
  return null;
}

/**
 * Validate config updates — reject dangerous values.
 */
function validateUpdates(updates: Record<string, string>): string | null {
  const errors: string[] = [];
  for (const [key, value] of Object.entries(updates)) {
    if (typeof key !== "string" || typeof value !== "string") {
      errors.push(`Invalid type for key "${key}"`);
      continue;
    }
    // Block shell injection: no backticks, $(), ${}, $VAR, $1, $?, semicolons, pipes, ampersands, redirects, parens, newlines, or quotes.
    // Bare $VAR references are also blocked — they would be expanded by bash when
    // sourcing the config, allowing exfiltration of environment variables or
    // unintended value injection. Positional ($1..$9) and special ($?, $!, $@, $$)
    // params are also blocked as they expand to process state in bash.
    if (/[`"'|&><()#]|\$[({a-zA-Z_0-9?!@*#$-]|;|\n|\r|\t/.test(value)) {
      errors.push(`Unsafe characters in value for "${key}"`);
      continue;
    }
    // Block non-ASCII control characters and Unicode zero-width/line-separator chars.
    if (containsDisallowedChars(value)) {
      errors.push(`Non-printable characters in value for "${key}"`);
      continue;
    }
    if (EXECUTABLE_KEYS.has(key)) {
      if (!/^[a-zA-Z0-9 ./_:=-]+$/.test(value)) {
        errors.push(`Executable config "${key}" contains disallowed characters`);
        continue;
      }
      // Block path traversal attempts in executable values
      if (/\.\.\//.test(value)) {
        errors.push(`Executable config "${key}" must not contain path traversal (../)`);
        continue;
      }
    }
    // Key must be a valid bash variable name
    if (!VALID_CONFIG_KEY.test(key)) {
      errors.push(`Invalid config key "${key}"`);
      continue;
    }
    // Only allow known mutable config keys
    if (!MUTABLE_KEYS.has(key)) {
      errors.push(`Key '${key}' is not in the list of updatable configuration keys`);
      continue;
    }
    const integerRule = INTEGER_RULES[key];
    if (integerRule) {
      const integerError = validateIntegerValue(key, value, integerRule);
      if (integerError) {
        errors.push(integerError);
        continue;
      }
    }
    if (BOOLEAN_KEYS.has(key)) {
      const booleanError = validateBooleanValue(key, value);
      if (booleanError) {
        errors.push(booleanError);
        continue;
      }
    }
    const urlRule = URL_RULES[key];
    if (urlRule) {
      const urlError = validateUrlValue(key, value, urlRule);
      if (urlError) {
        errors.push(urlError);
        continue;
      }
    }
    if (key === "SKYNET_NOTIFY_CHANNELS") {
      const notifyError = validateNotifyChannelsValue(value);
      if (notifyError) {
        errors.push(notifyError);
        continue;
      }
    }
    if (key === "SKYNET_TG_CHAT_ID") {
      const chatIdError = validateTelegramChatIdValue(value);
      if (chatIdError) {
        errors.push(chatIdError);
        continue;
      }
    }
  }
  return errors.length > 0 ? errors.join("; ") : null;
}

function containsDisallowedChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    const isAsciiControl =
      (code >= 0x00 && code <= 0x08) ||
      code === 0x0b ||
      code === 0x0c ||
      (code >= 0x0e && code <= 0x1f) ||
      (code >= 0x7f && code <= 0x9f);
    if (isAsciiControl) return true;
  }

  // zero-width/control-like Unicode chars often used for obfuscation
  return /[\u200B-\u200F\u2028-\u2029\uFEFF]/.test(value);
}

/**
 * Create GET and POST handlers for the config endpoint.
 *
 * GET: Parse skynet.config.sh and return key-value pairs.
 * POST: Validate and write updated values back.
 *
 * Error message convention: all user-facing error strings use sentence case
 * (e.g., "Config file not found", not "Config File Not Found"). This matches
 * the convention used across all handlers.
 */
/**
 * Keys containing secrets that should be masked in GET responses.
 * These values are write-only from the dashboard's perspective.
 */
export const SENSITIVE_KEYS = new Set([
  "SKYNET_TG_BOT_TOKEN",
  "SKYNET_SLACK_WEBHOOK_URL",
  "SKYNET_DISCORD_WEBHOOK_URL",
  "SKYNET_DASHBOARD_API_KEY",
]);

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
      const entries = parseConfigFile(raw).map(e => ({
        ...e,
        value: SENSITIVE_KEYS.has(e.key) && e.value ? "••••••••" : e.value,
      }));

      return Response.json({
        data: { entries, configPath },
        error: null,
      });
    } catch (err) {
      logHandlerError(config.devDir, "config:GET", err);
      return Response.json(
        {
          data: null,
          error: process.env.NODE_ENV === "development"
            ? (err instanceof Error ? err.message : "Internal error")
            : "Internal server error",
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

      // Acquire mkdir-based mutex lock around the read-modify-write cycle
      // OPS-P2-3: Add PID file inside lock dir and stale detection (TTL 30s)
      const lockPath = `${config.devDir}/config.lock`;
      const lockPidFile = `${lockPath}/pid`;
      const LOCK_TTL_MS = 30_000;
      let lockAcquired = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        try {
          mkdirSync(lockPath);
          writeFileSync(lockPidFile, String(process.pid), "utf-8");
          lockAcquired = true;
          break;
        } catch {
          // Check for stale lock: PID dead or lock older than TTL
          try {
            const pidStr = readFileSync(lockPidFile, "utf-8").trim();
            const holderPid = Number(pidStr);
            let isStale = false;

            // Check if holder PID is dead
            if (Number.isFinite(holderPid) && holderPid > 0) {
              try { process.kill(holderPid, 0); } catch { isStale = true; }
            }

            // Check lock age > TTL
            if (!isStale) {
              try {
                const mtime = statSync(lockPidFile).mtimeMs;
                if (Date.now() - mtime > LOCK_TTL_MS) isStale = true;
              } catch { /* stat failed — lock dir may have been released */ }
            }

            if (isStale) {
              try { rmSync(lockPath, { recursive: true, force: true }); } catch { /* ignore */ }
              continue; // Retry acquisition immediately
            }
          } catch { /* No PID file — lock dir may be partially created, retry */ }
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      if (!lockAcquired) {
        return Response.json(
          { data: null, error: "Config file is locked by another process" },
          { status: 423 }
        );
      }

      try {
        const missingKeys = writeConfigFile(configPath, updates);

        // Re-read to return updated state
        const raw = readFileSync(configPath, "utf-8");
        const entries = parseConfigFile(raw).map(e => ({
          ...e,
          value: SENSITIVE_KEYS.has(e.key) && e.value ? "••••••••" : e.value,
        }));

        const warning = missingKeys.length > 0
          ? `Keys not found in config file (not updated): ${missingKeys.join(", ")}`
          : null;

        return Response.json({
          data: { entries, configPath, updatedKeys: Object.keys(updates), ...(warning ? { warning } : {}) },
          error: null,
        });
      } finally {
        try { rmSync(lockPath, { recursive: true, force: true }); } catch { /* lock cleanup failure is non-fatal */ }
      }
    } catch (err) {
      logHandlerError(config.devDir, "config:POST", err);
      return Response.json(
        {
          data: null,
          error: process.env.NODE_ENV === "development"
            ? (err instanceof Error ? err.message : "Internal error")
            : "Internal server error",
        },
        { status: 500 }
      );
    }
  }

  return { GET, POST };
}
