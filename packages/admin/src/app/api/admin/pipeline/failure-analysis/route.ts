import { createPipelineFailureAnalysisHandler } from "@ajioncorp/skynet/handlers";
import { config } from "@/lib/skynet-config";

export const GET = createPipelineFailureAnalysisHandler(config);
export const dynamic = "force-dynamic";
