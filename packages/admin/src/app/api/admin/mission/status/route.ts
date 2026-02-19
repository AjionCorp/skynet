import { createMissionStatusHandler } from "@ajioncorp/skynet/handlers";
import { config } from "@/lib/skynet-config";

export const GET = createMissionStatusHandler(config);
export const dynamic = "force-dynamic";
