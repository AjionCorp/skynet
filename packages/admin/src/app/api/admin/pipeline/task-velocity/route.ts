import { createTaskVelocityHandler } from "@ajioncorp/skynet/handlers";
import { config } from "@/lib/skynet-config";

export const GET = createTaskVelocityHandler(config);
export const dynamic = "force-dynamic";
