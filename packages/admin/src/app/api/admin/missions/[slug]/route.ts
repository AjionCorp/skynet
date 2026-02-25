import { createMissionDetailHandler } from "@ajioncorp/skynet/handlers";
import { config } from "@/lib/skynet-config";

const handler = createMissionDetailHandler(config);
export const GET = handler.GET;
export const PUT = handler.PUT;
export const DELETE = handler.DELETE;
export const dynamic = "force-dynamic";
