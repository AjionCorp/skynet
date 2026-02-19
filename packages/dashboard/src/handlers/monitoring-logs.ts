import type { SkynetConfig } from "../types";
import { createPipelineLogsHandler } from "./pipeline-logs";

/**
 * Create a GET handler for the monitoring/logs endpoint.
 *
 * This is functionally identical to the pipeline-logs handler. We re-export it
 * so consumers can mount it at /api/admin/monitoring/logs.
 */
export function createMonitoringLogsHandler(config: SkynetConfig) {
  return createPipelineLogsHandler(config);
}
