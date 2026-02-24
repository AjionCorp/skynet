import { createPipelineHealthTrendHandler } from "@ajioncorp/skynet/handlers";
import { config } from "@/lib/skynet-config";

export const GET = createPipelineHealthTrendHandler(config);
export const dynamic = "force-dynamic";
