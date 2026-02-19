import { createMissionRawHandler } from "@ajioncorp/skynet/handlers";
import { config } from "@/lib/skynet-config";

export const GET = createMissionRawHandler(config);
export const dynamic = "force-dynamic";
