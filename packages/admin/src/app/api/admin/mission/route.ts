import { createMissionHandler } from "@ajioncorp/skynet/handlers";
import { config } from "@/lib/skynet-config";

export const GET = createMissionHandler(config);
export const dynamic = "force-dynamic";
