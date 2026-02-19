import type { SkynetConfig } from "../types";
import { readDevFile } from "../lib/file-reader";

/**
 * Create a GET handler for the mission endpoint.
 * Returns the raw contents of .dev/mission.md.
 */
export function createMissionRawHandler(config: SkynetConfig) {
  const { devDir } = config;

  return async function GET(): Promise<Response> {
    try {
      const raw = readDevFile(devDir, "mission.md");

      return Response.json({
        data: { raw },
        error: null,
      });
    } catch (err) {
      return Response.json(
        {
          data: null,
          error:
            err instanceof Error
              ? err.message
              : "Failed to read mission.md",
        },
        { status: 500 }
      );
    }
  };
}
