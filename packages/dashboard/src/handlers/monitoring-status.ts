import type { SkynetConfig } from "../types";
import { createPipelineStatusHandler } from "./pipeline-status";

/**
 * Create a GET handler for the monitoring/status endpoint.
 *
 * This is functionally identical to the pipeline-status handler -- the monitoring
 * dashboard consumes the same full status payload. We re-export it here under a
 * separate name so consumers can mount it at /api/admin/monitoring/status.
 */
export function createMonitoringStatusHandler(config: SkynetConfig) {
  return createPipelineStatusHandler(config);
}
