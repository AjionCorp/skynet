/**
 * Default stale threshold in seconds (45 minutes).
 * Conservative fallback matching the config template default (SKYNET_STALE_MINUTES=45).
 * Handlers override this constant with the config value when present.
 * Only used as a last-resort default when SkynetConfig.staleMinutes is not available.
 */
export const STALE_THRESHOLD_SECONDS = 45 * 60; // 2700 seconds = 45 minutes

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
