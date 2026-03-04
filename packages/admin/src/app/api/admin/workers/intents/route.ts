import { createWorkerIntentsHandler } from "@ajioncorp/skynet/handlers";
import { config } from "@/lib/skynet-config";

const handlers = createWorkerIntentsHandler(config);
export const GET = handlers.GET;
export const dynamic = "force-dynamic";
