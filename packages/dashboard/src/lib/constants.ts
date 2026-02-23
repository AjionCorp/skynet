/**
 * Stale threshold for worker heartbeats, in seconds.
 * A heartbeat older than this is considered stale/stuck.
 * Default matches SKYNET_STALE_MINUTES (45 min) from skynet.config.sh.
 */
export const STALE_THRESHOLD_SECONDS = 45 * 60;
