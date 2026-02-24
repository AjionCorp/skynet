import { createMetricsHandler } from "@ajioncorp/skynet/handlers";
import { config } from "@/lib/skynet-config";

export const GET = createMetricsHandler(config);
export const dynamic = "force-dynamic";
