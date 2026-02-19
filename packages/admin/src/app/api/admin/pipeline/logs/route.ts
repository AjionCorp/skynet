import { createPipelineLogsHandler } from "@ajioncorp/skynet";
import { config } from "@/lib/skynet-config";

export const GET = createPipelineLogsHandler(config);
export const dynamic = "force-dynamic";
