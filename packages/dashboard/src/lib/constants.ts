/**
 * Stale threshold for worker heartbeats, in seconds.
 * A heartbeat older than this is considered stale/stuck.
 * Default matches SKYNET_STALE_MINUTES (45 min) from skynet.config.sh.
 */
export const STALE_THRESHOLD_SECONDS = 45 * 60;

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
