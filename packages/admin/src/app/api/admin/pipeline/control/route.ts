import { createPipelineControlHandler } from "@ajioncorp/skynet/handlers";
import { config } from "@/lib/skynet-config";

const handler = createPipelineControlHandler(config);
export const POST = handler.POST;
export const dynamic = "force-dynamic";
