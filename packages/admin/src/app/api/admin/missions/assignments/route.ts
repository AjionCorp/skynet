import { createMissionAssignmentsHandler } from "@ajioncorp/skynet/handlers";
import { config } from "@/lib/skynet-config";

const handler = createMissionAssignmentsHandler(config);
export const GET = handler.GET;
export const PUT = handler.PUT;
export const dynamic = "force-dynamic";
