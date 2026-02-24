// Auth: Protected by middleware.ts — all /api/* routes require SKYNET_DASHBOARD_API_KEY
import { createMetricsHandler } from "@ajioncorp/skynet/handlers";
import { config } from "@/lib/skynet-config";

export const GET = createMetricsHandler(config);
export const dynamic = "force-dynamic";
