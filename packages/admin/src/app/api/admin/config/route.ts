import { createConfigHandler } from "@ajioncorp/skynet/handlers";
import { config } from "@/lib/skynet-config";

const handlers = createConfigHandler(config);

export const GET = handlers.GET;
export const POST = handlers.POST;
export const dynamic = "force-dynamic";
