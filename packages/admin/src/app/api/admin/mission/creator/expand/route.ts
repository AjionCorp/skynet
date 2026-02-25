import { createMissionCreatorHandler } from "@ajioncorp/skynet/handlers";
import { config } from "@/lib/skynet-config";

const handler = createMissionCreatorHandler(config);
export const POST = handler.expand;
export const dynamic = "force-dynamic";
