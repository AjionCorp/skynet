import { createPromptsHandler } from "@ajioncorp/skynet/handlers";
import { config } from "@/lib/skynet-config";

export const GET = createPromptsHandler(config);
export const dynamic = "force-dynamic";
