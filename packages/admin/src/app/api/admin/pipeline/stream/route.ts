import { createPipelineStreamHandler } from "@ajioncorp/skynet/handlers";
import { config } from "@/lib/skynet-config";

export const GET = createPipelineStreamHandler(config);
export const dynamic = "force-dynamic";
