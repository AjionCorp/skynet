import { createProjectDriverStatusHandler } from "@ajioncorp/skynet/handlers";
import { config } from "@/lib/skynet-config";

export const GET = createProjectDriverStatusHandler(config);
export const dynamic = "force-dynamic";
