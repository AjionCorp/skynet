import { createMissionStatusHandler } from "@ajioncorp/skynet/handlers";
import { config } from "@/lib/skynet-config";

const handler = createMissionStatusHandler(config);
export const GET = (request: Request) => handler(request);
export const dynamic = "force-dynamic";
