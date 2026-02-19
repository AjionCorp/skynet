import { createMonitoringLogsHandler } from "@ajioncorp/skynet/handlers";
import { config } from "@/lib/skynet-config";

export const GET = createMonitoringLogsHandler(config);
export const dynamic = "force-dynamic";
