import { createMonitoringStatusHandler } from "@ajioncorp/skynet/handlers";
import { config } from "@/lib/skynet-config";

export const GET = createMonitoringStatusHandler(config);
export const dynamic = "force-dynamic";
