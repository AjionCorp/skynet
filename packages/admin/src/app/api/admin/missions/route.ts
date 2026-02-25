import { createMissionsHandler } from "@ajioncorp/skynet/handlers";
import { config } from "@/lib/skynet-config";

const handler = createMissionsHandler(config);
export const GET = handler.GET;
export const POST = handler.POST;
export const dynamic = "force-dynamic";
