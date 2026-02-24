/**
 * Stale threshold for worker heartbeats, in seconds.
 * Default: 30 minutes (1800s) — MUST match SKYNET_STALE_MINUTES in _config.sh (line 63).
 * Not to be confused with SKYNET_AGENT_TIMEOUT_MINUTES (45m default), which is the
 * maximum allowed time for a single agent invocation.
 * When SkynetConfig.staleMinutes is available (set from config), that value takes precedence.
 * This constant is only used as a fallback when the config value is not available.
 */
export const STALE_THRESHOLD_SECONDS = 30 * 60; // 1800 seconds = 30 minutes

/**
 * Validates script names and worker types: lowercase alphanumeric and hyphens only.
 * Used in pipeline-trigger, pipeline-logs, worker-scaling handlers.
 */
export const SAFE_SCRIPT_NAME = /^[a-z0-9-]+$/;

/**
 * Validates script file paths: alphanumeric, dots, underscores, and hyphens only.
 * Used in monitoring-agents handler for plist script paths.
 */
export const SAFE_SCRIPT_PATH = /^[a-zA-Z0-9._-]+$/;

/**
 * Validates agent names: alphanumeric, underscores, and hyphens only.
 * Used in monitoring-agents handler for cron-derived agent names.
 */
export const SAFE_AGENT_NAME = /^[a-zA-Z0-9_-]+$/;

/**
 * Validates bash config variable names: uppercase with underscores.
 * Used in config handler for key validation.
 */
export const VALID_CONFIG_KEY = /^[A-Z_][A-Z0-9_]*$/;
