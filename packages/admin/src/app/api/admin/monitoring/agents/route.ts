import { createMonitoringAgentsHandler } from "@ajioncorp/skynet";
import { config } from "@/lib/skynet-config";

export const GET = createMonitoringAgentsHandler(config);
export const dynamic = "force-dynamic";
