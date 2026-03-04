import { createMissionStateHandler } from "@ajioncorp/skynet/handlers";
import { config } from "@/lib/skynet-config";

const handler = createMissionStateHandler(config);
export const GET = (request: Request) => handler.GET(request);
export const POST = (request: Request) => handler.POST(request);
export const dynamic = "force-dynamic";
