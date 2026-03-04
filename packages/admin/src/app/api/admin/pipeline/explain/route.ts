import { createPipelineExplainHandler } from "@ajioncorp/skynet/handlers";
import { config } from "@/lib/skynet-config";

export const GET = createPipelineExplainHandler(config);
export const dynamic = "force-dynamic";
