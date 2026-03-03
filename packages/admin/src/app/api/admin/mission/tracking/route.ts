import { createMissionTrackingHandler } from "@ajioncorp/skynet/handlers";
import { config } from "@/lib/skynet-config";

const handler = createMissionTrackingHandler(config);
export const GET = (request: Request) => handler(request);
export const dynamic = "force-dynamic";
