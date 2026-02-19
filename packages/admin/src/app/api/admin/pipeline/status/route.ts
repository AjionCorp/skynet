import { createPipelineStatusHandler } from "@ajioncorp/skynet";
import { config } from "@/lib/skynet-config";

export const GET = createPipelineStatusHandler(config);
export const dynamic = "force-dynamic";
