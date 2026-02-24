import type { SkynetConfig } from "../types";
import { healthTrendBuffer } from "./pipeline-status";

/**
 * Create a GET handler for the /api/pipeline/health-trend endpoint.
 * Returns the in-memory ring buffer of recent health scores.
 */
export function createPipelineHealthTrendHandler(_config: SkynetConfig) {
  return async function GET(): Promise<Response> {
    return Response.json({ data: healthTrendBuffer, error: null });
  };
}
