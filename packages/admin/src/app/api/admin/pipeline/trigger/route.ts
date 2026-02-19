import { createPipelineTriggerHandler } from "@ajioncorp/skynet/handlers";
import { config } from "@/lib/skynet-config";

export const POST = createPipelineTriggerHandler(config);
export const dynamic = "force-dynamic";
