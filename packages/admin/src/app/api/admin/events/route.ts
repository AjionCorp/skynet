import { createEventsHandler } from "@ajioncorp/skynet/handlers";
import { config } from "@/lib/skynet-config";

export const GET = createEventsHandler(config);
export const dynamic = "force-dynamic";
